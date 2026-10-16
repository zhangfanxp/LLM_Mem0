import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

// Exercise the actual app's HTTP, streaming and playback coordination without
// contacting NVIDIA/Mem0 or using the real microphone.
const source = (await readFile(new URL("../web/app.js", import.meta.url), "utf8"))
  .replace(/^import[^\n]+\n/, "")
  .replace(/\nloadConfig\(\);\s*$/, "\n");

class Element {
  children = [];
  value = "";
  style = {};
  dataset = {};
  className = "";
  textContent = "";
  listeners = new Map();
  classList = { toggle() {}, add() {}, remove() {}, contains: () => true };
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(callback);
  }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.get("close")?.forEach((callback) => callback()); }
  setAttribute() {}
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  remove() {}
  focus() {}
  querySelector() { return new Element(); }
  get lastElementChild() { return this.children.at(-1); }
}

function createApp(fetch, specifications = []) {
  const elements = new Map();
  const settingsFields = specifications.map(({ key, secret = false }) => {
    const field = new Element();
    field.dataset = { setting: key, ...(secret ? { secret: "true" } : {}) };
    return field;
  });
  const clearFields = settingsFields.filter((field) => field.dataset.secret).map((field) => {
    const checkbox = new Element();
    checkbox.dataset = { clearSecret: field.dataset.setting };
    checkbox.checked = false;
    return checkbox;
  });
  const timers = new Map();
  const audio = [];
  let nextTimer = 1;
  class Voice {
    wakeEnabled = true;
    canWake = true;
    supported = true;
    capturing = false;
    recording = false;
    phase = "listening";
    status = "等待唤醒";
    wakePhrase = "你好迦童";
    blocks = [];
    constructor(options) { this.options = options; }
    setBlocked(value) { this.blocked = value; this.blocks.push(value); }
    setHidden() {}
    setWakePhrase(value) { this.wakePhrase = value; }
    stopWake() { return Promise.resolve(); }
    async startRecording() { this.capturing = true; }
  }
  class Audio extends EventTarget {
    paused = true;
    constructor(url) { super(); this.url = url; audio.push(this); }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; this.dispatchEvent(new Event("pause")); }
    end() { this.paused = true; this.dispatchEvent(new Event("ended")); }
  }
  const context = vm.createContext({
    VoiceInputController: Voice,
    document: {
      hidden: false,
      querySelector: (selector) => {
        if (selector.startsWith("#typing-indicator")) return null;
        const setting = selector.match(/^\[data-setting="([^"]+)"\]$/)?.[1];
        if (setting) return settingsFields.find((field) => field.dataset.setting === setting);
        const clear = selector.match(/^\[data-clear-secret="([^"]+)"\]$/)?.[1];
        if (clear) return clearFields.find((field) => field.dataset.clearSecret === clear);
        if (!elements.has(selector)) elements.set(selector, new Element());
        return elements.get(selector);
      },
      querySelectorAll: (selector) => selector === "[data-setting]" ? settingsFields
        : selector === "[data-clear-secret]" ? clearFields
          : selector === '[data-secret="true"]' ? settingsFields.filter((field) => field.dataset.secret) : [],
      createElement: () => new Element(),
      createTextNode: (text) => text,
      addEventListener() {}
    },
    window: {
      setTimeout: (callback) => { const id = nextTimer++; timers.set(id, callback); return id; },
      clearTimeout: (id) => timers.delete(id),
      addEventListener() {}
    },
    localStorage: { getItem: () => null, setItem() {} },
    requestAnimationFrame: (callback) => callback(),
    fetch,
    Audio, URL, Blob, AbortController, DOMException, TextDecoder, atob, console
  });
  vm.runInContext(source + `
    globalThis.app = {
      voice, sendMessage, transcribeRecording, playSpeech, toggleRecording, openSettings, saveSettings,
      playWakeReply, applyVoiceConfig, prepareWakeReplyAudio,
      state: () => ({ busy, voiceProcessing, speechPreparing, streamAudioPlaying }),
      transcript: () => input.value
    };
  `, context, { filename: "app.js" });
  return { ...context.app, audio, timers, elements, settingsFields, clearFields };
}

async function flush() { for (let index = 0; index < 30; index += 1) await Promise.resolve(); }

test("transcription sends one voice chat and keeps wake paused until all audio ends", async () => {
  const requests = [];
  const app = createApp(async (path, options) => {
    requests.push({ path, options });
    if (path === "/api/transcribe") return Response.json({ text: "帮我安排明天的工作" });
    assert.equal(path, "/api/chat/stream");
    return new Response([
      'event: text_done\ndata: {"answer":"好的，我们一起安排。"}\n\n',
      'event: audio\ndata: {"audio":"YXVkaW8="}\n\n',
      'event: complete\ndata: {}\n\n'
    ].join(""));
  });
  await app.transcribeRecording(new Blob(["voice"], { type: "audio/webm" }));
  assert.equal(requests.length, 2);
  const body = JSON.parse(requests[1].options.body);
  assert.equal(body.message, "帮我安排明天的工作");
  assert.equal(body.speak, true);
  assert.equal(app.state().busy, false);
  assert.equal(app.state().voiceProcessing, false);
  assert.equal(app.voice.blocked, true, "SSE completion does not end audio playback");
  app.audio[0].end();
  await flush();
  assert.equal(app.voice.blocked, false);
  assert.equal(app.state().streamAudioPlaying, false);
});

test("failed transcription releases the composer and wake blocker", async () => {
  const app = createApp(async () => new Response('{"error":"转写失败"}', { status: 502 }));
  await app.transcribeRecording(new Blob(["voice"]));
  assert.equal(app.state().voiceProcessing, false);
  assert.equal(app.voice.blocked, false);
  assert.equal(app.elements.get("#send-button").disabled, false);
});

test("text, suggestions and playback cannot submit during active recording", async () => {
  let requests = 0;
  const app = createApp(async () => { requests += 1; throw new Error("unexpected request"); });
  app.voice.capturing = true;
  await app.sendMessage("这条消息不能提前提交");
  await app.playSpeech({ content: "这条回答不能在录音时播放" });
  assert.equal(requests, 0);
});

test("manual playback pauses wake and restores it on audio end", async () => {
  const app = createApp(async (path) => {
    assert.equal(path, "/api/speech");
    return new Response(new Blob(["audio"], { type: "audio/mpeg" }));
  });
  await app.playSpeech({ content: "测试回答" });
  assert.equal(app.voice.blocked, true);
  app.audio[0].end();
  assert.equal(app.voice.blocked, false);
});

test("transcription timeout aborts the upload and resumes wake", async () => {
  const app = createApp(async (_path, options) => new Promise((_, reject) => {
    options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  }));
  const pending = app.transcribeRecording(new Blob(["voice"]));
  assert.equal(app.voice.blocked, true);
  [...app.timers.values()][0]();
  await pending;
  assert.equal(app.voice.blocked, false);
  assert.equal(app.state().voiceProcessing, false);
});

test("a delayed speech synthesis response cannot play over a newer recording", async () => {
  let completeSpeech;
  const app = createApp(async () => new Promise((resolve) => { completeSpeech = resolve; }));
  const pending = app.playSpeech({ content: "这条语音已经被用户取消" });
  await flush();
  await app.toggleRecording();
  assert.equal(app.voice.capturing, true);
  completeSpeech(new Response(new Blob(["audio"], { type: "audio/mpeg" })));
  await pending;
  assert.equal(app.audio.length, 0);
  assert.equal(app.state().speechPreparing, false);
});

test("settings preserve blank secrets, apply the new wake phrase and resume wake on close", async () => {
  const requests = [];
  const values = { WAKE_PHRASE: "你好迦童", PORT: "5001", NVIDIA_DEFAULT_MODEL: "model" };
  const app = createApp(async (path, options) => {
    requests.push({ path, options });
    if (path === "/api/config") return Response.json({ models: [], wake_phrase: values.WAKE_PHRASE });
    if (options.method === "POST") {
      assert.equal(options.headers["X-Settings-Token"], "test-token");
      const body = JSON.parse(options.body);
      assert.equal(Object.hasOwn(body.values, "NVIDIA_API_KEY"), false);
      assert.deepEqual(body.clear_secrets, []);
      values.WAKE_PHRASE = body.values.WAKE_PHRASE;
      return Response.json({ values, secrets: { NVIDIA_API_KEY: true }, restart_required: false });
    }
    return Response.json({ values, secrets: { NVIDIA_API_KEY: true }, models: [], csrf_token: "test-token" });
  }, [{ key: "WAKE_PHRASE" }, { key: "PORT" }, { key: "NVIDIA_DEFAULT_MODEL" }, { key: "NVIDIA_API_KEY", secret: true }]);
  await app.openSettings();
  assert.equal(app.voice.blocked, true);
  const secret = app.settingsFields.find((field) => field.dataset.secret);
  assert.equal(secret.value, "");
  assert.match(secret.placeholder, /已配置/);
  app.settingsFields[0].value = "你好小助手";
  await app.saveSettings({ preventDefault() {} });
  assert.equal(app.voice.wakePhrase, "你好小助手");
  assert.match(app.elements.get("#settings-status").textContent, /已保存/);
  app.elements.get("#settings-dialog").close();
  assert.equal(app.voice.blocked, false);
  assert.equal(secret.value, "");
  assert.equal(requests.length, 3);
});

test("failed settings load prevents saving and closing restores wake", async () => {
  let requests = 0;
  const app = createApp(async () => { requests += 1; return new Response('{"error":"读取失败"}', { status: 500 }); });
  await app.openSettings();
  assert.equal(app.elements.get("#save-settings").disabled, true);
  await app.saveSettings({ preventDefault() {} });
  assert.equal(requests, 1);
  assert.match(app.elements.get("#settings-status").textContent, /读取失败/);
  app.elements.get("#settings-dialog").close();
  assert.equal(app.voice.blocked, false);
});

test("a settings response arriving after closing the dialog cannot overwrite the form", async () => {
  let complete;
  const app = createApp(async () => new Promise((resolve) => { complete = resolve; }), [{ key: "WAKE_PHRASE" }]);
  const pending = app.openSettings();
  app.elements.get("#settings-dialog").close();
  complete(Response.json({ values: { WAKE_PHRASE: "过期响应" }, secrets: {}, csrf_token: "old-token" }));
  await pending;
  assert.equal(app.settingsFields[0].value, "");
  assert.equal(app.voice.blocked, false);
});

function replyAudioContext() {
  const sources = [];
  return {
    sources,
    destination: {},
    async decodeAudioData(data) { assert.ok(data.byteLength > 0); return { duration: 1 }; },
    createBufferSource() {
      const source = {
        connect() {}, disconnect() {},
        start() { this.started = true; },
        stop() { this.stopped = true; },
        end() { this.onended?.(); }
      };
      sources.push(source);
      return source;
    }
  };
}

test("configured wake replies use cached speech and resolve only after playback ends", async () => {
  const requests = [];
  const app = createApp(async (path, options) => {
    requests.push({ path, text: JSON.parse(options.body).text });
    return new Response("test audio", { headers: { "Content-Type": "audio/mpeg" } });
  });
  app.applyVoiceConfig({ wake_phrase: "童童大王", wake_reply_text: "你好，主人您有什么吩咐", tts_voice: "voice-a" });
  const audioContext = replyAudioContext();
  const signal = new AbortController().signal;
  let completed = false;
  const pending = app.playWakeReply({ signal, audioContext }).then(() => { completed = true; });
  await flush();
  assert.equal(audioContext.sources[0].started, true);
  assert.equal(completed, false);
  assert.deepEqual(requests, [{ path: "/api/speech", text: "你好，主人您有什么吩咐" }]);
  audioContext.sources[0].end();
  await pending;
  const second = app.playWakeReply({ signal, audioContext });
  await flush();
  audioContext.sources[1].end();
  await second;
  assert.equal(requests.length, 1, "fixed speech is reused across wakes");
});

test("cancelling a wake reply stops its Web Audio source", async () => {
  const app = createApp(async () => new Response("test audio"));
  const audioContext = replyAudioContext();
  const controller = new AbortController();
  const pending = app.playWakeReply({ signal: controller.signal, audioContext });
  await flush();
  const rejected = assert.rejects(pending, { name: "AbortError" });
  controller.abort();
  await rejected;
  assert.equal(audioContext.sources[0].stopped, true);
});

test("changing the saved reply or voice invalidates the prepared audio", async () => {
  const requests = [];
  const app = createApp(async (_path, options) => {
    requests.push(JSON.parse(options.body).text);
    return new Response("test audio");
  });
  app.applyVoiceConfig({ wake_phrase: "童童大王", wake_reply_text: "主人，我在。", tts_voice: "voice-a" });
  await app.prepareWakeReplyAudio();
  app.applyVoiceConfig({ wake_phrase: "童童大王", wake_reply_text: "请吩咐。", tts_voice: "voice-a" });
  await app.prepareWakeReplyAudio();
  app.applyVoiceConfig({ wake_phrase: "童童大王", wake_reply_text: "请吩咐。", tts_voice: "voice-b" });
  await app.prepareWakeReplyAudio();
  assert.deepEqual(requests, ["主人，我在。", "请吩咐。", "请吩咐。"]);
});

test("a cancelled greeting cannot start playback when synthesis eventually completes", async () => {
  let complete;
  const app = createApp(async () => new Promise((resolve) => { complete = resolve; }));
  const audioContext = replyAudioContext();
  const controller = new AbortController();
  const pending = app.playWakeReply({ signal: controller.signal, audioContext });
  controller.abort();
  complete(new Response("test audio"));
  await pending;
  assert.equal(audioContext.sources.length, 0);
});
