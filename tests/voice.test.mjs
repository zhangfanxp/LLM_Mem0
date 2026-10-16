import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesWakePhrase, VoiceActivityDetector, VoiceInputController } from "../web/voice.mjs";

const silence = new Float32Array(128);
const speech = Float32Array.from({ length: 128 }, (_, index) => index % 2 ? 0.05 : -0.05);

test("matches the full Chinese wake phrase, punctuation and name homophones", () => {
  for (const text of ["你好，迦童", "你好 佳彤！", "你好嘉童帮我记一下", "你好，伽桐。", "你 好，迦 童"]) {
    assert.equal(matchesWakePhrase(text), true, text);
  }
  for (const text of ["你好", "迦童", "你好，小童", "今天是个好天气", "你好迦", "你好，儿童", null]) {
    assert.equal(matchesWakePhrase(text), false, String(text));
  }
});

test("custom wake phrases replace the default while tolerating punctuation and case", () => {
  assert.equal(matchesWakePhrase("嘿，小助手！", "嘿小助手"), true);
  assert.equal(matchesWakePhrase("HELLO, TONG", "hello tong"), true);
  assert.equal(matchesWakePhrase("你好迦童", "嘿小助手"), false);
  assert.equal(matchesWakePhrase("随意讲话", "！！！"), false);
});

test("童童大王 wakes on ASR homophones without accepting partial or different syllables", () => {
  for (const text of ["童童大王", "同同大王", "彤彤大王", "通通，大王！", "桐桐大王帮我一下"]) {
    assert.equal(matchesWakePhrase(text, "童童大王"), true, text);
  }
  for (const text of ["童童", "大王", "冬冬大王", "今天大王来了", "主人有什么吩咐"]) {
    assert.equal(matchesWakePhrase(text, "童童大王"), false, text);
  }
  assert.equal(matchesWakePhrase("先来了", "西安"), false, "different syllable boundaries must not collide");
});

test("ends only after sustained speech followed by the configured silence", () => {
  const vad = new VoiceActivityDetector({ silenceMs: 1200 });
  for (let time = 0; time <= 600; time += 50) assert.equal(vad.process(speech, time), null);
  assert.equal(vad.hasSpeech, true);
  for (let time = 650; time < 1800; time += 50) assert.equal(vad.process(silence, time), null);
  assert.equal(vad.process(silence, 1800), "silence");
  assert.equal(vad.process(silence, 2000), null, "a completed utterance emits once");
});

test("a short pause followed by speech resets the silence countdown", () => {
  const vad = new VoiceActivityDetector({ silenceMs: 800 });
  for (let time = 0; time <= 400; time += 50) vad.process(speech, time);
  for (let time = 450; time <= 1000; time += 50) assert.equal(vad.process(silence, time), null);
  for (let time = 1050; time <= 1400; time += 50) assert.equal(vad.process(speech, time), null);
  assert.equal(vad.process(silence, 2150), null);
  assert.equal(vad.process(silence, 2200), "silence");
});

test("silence, DC offset and an isolated click never count as speech", () => {
  const vad = new VoiceActivityDetector();
  vad.process(silence, 0);
  vad.process(speech, 50);
  vad.process(silence, 100);
  vad.process(new Float32Array(128).fill(0.2), 1000);
  assert.equal(vad.hasSpeech, false);
  assert.equal(vad.process(silence, 8000), "no-speech");
});

test("continuous sound has a hard recording limit", () => {
  const vad = new VoiceActivityDetector();
  vad.process(speech, 0);
  vad.process(speech, 200);
  assert.equal(vad.process(speech, 120_000), "limit");
});

class FakeClock {
  now = 0;
  nextId = 1;
  jobs = new Map();
  add = (callback, delay = 0, repeat = false) => {
    const id = this.nextId++;
    this.jobs.set(id, { callback, at: this.now + delay, repeat, delay });
    return id;
  };
  clear = (id) => { this.jobs.delete(id); };
  tick(duration) {
    const target = this.now + duration;
    while (true) {
      const next = [...this.jobs].filter(([, job]) => job.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, job] = next;
      this.now = job.at;
      if (job.repeat) job.at += job.delay;
      else this.jobs.delete(id);
      job.callback();
    }
    this.now = target;
  }
}

async function flush() { for (let index = 0; index < 12; index += 1) await Promise.resolve(); }

async function browserTest(run) {
  const clock = new FakeClock();
  const env = { clock, amplitude: 0, recognizers: [], streams: [], contexts: [], recorders: [], errors: [], recordings: [], notices: [] };
  class Track extends EventTarget {
    stopped = false;
    stop() { this.stopped = true; }
  }
  class Recorder extends EventTarget {
    static isTypeSupported(type) { return type === "audio/webm;codecs=opus"; }
    constructor(stream, options) {
      super();
      this.stream = stream;
      this.mimeType = options?.mimeType || "audio/mp4";
      this.state = "inactive";
      env.recorders.push(this);
    }
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      queueMicrotask(() => {
        const data = new Event("dataavailable");
        data.data = new Blob(["recorded audio"]);
        this.dispatchEvent(data);
        this.dispatchEvent(new Event("stop"));
      });
    }
  }
  class Recognition {
    constructor() { env.recognizers.push(this); }
    start() { this.onstart?.(); }
    abort() { queueMicrotask(() => this.onend?.()); }
    result(...parts) {
      this.onresult?.({ results: parts.map((transcript) => [{ transcript }]) });
    }
  }
  class AudioContext {
    state = "running";
    constructor() { env.contexts.push(this); }
    resume() { this.state = "running"; return Promise.resolve(); }
    close() { this.state = "closed"; return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createBiquadFilter() { return { frequency: { value: 0 }, connect() {}, disconnect() {} }; }
    createAnalyser() {
      return {
        disconnect() {},
        getFloatTimeDomainData(samples) {
          for (let index = 0; index < samples.length; index += 1) samples[index] = index % 2 ? env.amplitude : -env.amplitude;
        }
      };
    }
  }
  const replacements = {
    isSecureContext: true,
    SpeechRecognition: Recognition,
    webkitSpeechRecognition: undefined,
    AudioContext,
    MediaRecorder: Recorder,
    navigator: { mediaDevices: { getUserMedia: async () => {
      const track = new Track();
      const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
      env.streams.push(stream);
      return stream;
    } } },
    performance: { now: () => clock.now },
    setTimeout: (callback, delay) => clock.add(callback, delay),
    clearTimeout: clock.clear,
    setInterval: (callback, delay) => clock.add(callback, delay, true),
    clearInterval: clock.clear
  };
  const originals = new Map(Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const voice = new VoiceInputController({
    onError: (error) => env.errors.push(error),
    onNotice: (notice) => env.notices.push(notice),
    onRecording: (blob) => { env.recordings.push(blob); voice.setBlocked(true); }
  });
  env.voice = voice;
  try { await run(env); }
  finally {
    voice.destroy();
    await flush();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test("wake -> record -> VAD -> processing -> wake, with no playback feedback", () => browserTest(async (env) => {
  const { voice, clock } = env;
  await voice.enableWake();
  assert.equal(voice.phase, "listening");
  assert.equal(env.streams.length, 0, "formal recording starts only after waking");
  env.recognizers[0].result("你好", "嘉童");
  await flush();
  assert.equal(voice.recording, true);
  assert.equal(voice.recognition, null);
  env.amplitude = 0.05;
  clock.tick(500);
  env.amplitude = 0;
  clock.tick(1200);
  await flush();
  assert.equal(env.recordings.length, 1);
  assert.equal(env.streams[0].getTracks()[0].stopped, true);
  assert.equal(voice.recognition, null, "transcription and playback keep wake blocked");
  voice.setBlocked(false);
  assert.equal(voice.phase, "listening");
  voice.setBlocked(true);
  await flush();
  assert.equal(voice.recognition, null);
  voice.setBlocked(false);
  assert.equal(voice.phase, "listening");
  assert.deepEqual(env.errors, []);
}));

test("manual recording works without SpeechRecognition and empty audio is discarded", () => browserTest(async (env) => {
  globalThis.SpeechRecognition = undefined;
  const voice = new VoiceInputController({ onRecording: (blob) => env.recordings.push(blob), onNotice: (notice) => env.notices.push(notice) });
  assert.equal(voice.canWake, false);
  await voice.startRecording();
  env.clock.tick(8000);
  await flush();
  assert.equal(voice.phase, "idle");
  assert.equal(env.recordings.length, 0);
  assert.equal(env.notices.length, 1);
  assert.equal(env.streams[0].getTracks()[0].stopped, true);
  assert.equal(env.contexts[0].state, "closed");
  voice.destroy();
}));

test("turning wake off cancels recording and prevents late uploads", () => browserTest(async (env) => {
  await env.voice.enableWake();
  env.recognizers[0].result("你好迦童");
  await flush();
  env.amplitude = 0.05;
  env.clock.tick(300);
  env.voice.disableWake();
  await flush();
  env.clock.tick(120_000);
  assert.equal(env.recordings.length, 0);
  assert.equal(env.voice.wakeEnabled, false);
  assert.equal(env.voice.recognition, null);
  assert.equal(env.streams[0].getTracks()[0].stopped, true);
  assert.equal(env.contexts[0].state, "closed");
}));

test("hiding the page cancels recording, returning restores wake", () => browserTest(async (env) => {
  await env.voice.enableWake();
  env.recognizers[0].result("你好迦童");
  await flush();
  env.voice.setHidden(true);
  await flush();
  assert.equal(env.recordings.length, 0);
  assert.equal(env.voice.recognition, null);
  assert.equal(env.streams[0].getTracks()[0].stopped, true);
  env.voice.setHidden(false);
  assert.equal(env.voice.phase, "listening");
}));

test("late microphone permission after cancellation releases the returned stream", () => browserTest(async (env) => {
  let grant;
  const original = navigator.mediaDevices.getUserMedia;
  navigator.mediaDevices.getUserMedia = () => new Promise((resolve) => { grant = resolve; });
  const pending = env.voice.startRecording();
  await flush();
  env.voice.disableWake();
  grant(await original());
  await pending;
  assert.equal(env.voice.phase, "idle");
  assert.equal(env.streams[0].getTracks()[0].stopped, true);
  assert.equal(env.recorders.length, 0);
}));

test("network and permission failures stop wake instead of retrying forever", () => browserTest(async (env) => {
  await env.voice.enableWake();
  env.recognizers[0].onerror({ error: "network" });
  await flush();
  env.clock.tick(20_000);
  assert.equal(env.voice.wakeEnabled, false);
  assert.equal(env.recognizers.length, 1);
  assert.match(env.errors[0], /连接失败/);
  navigator.mediaDevices.getUserMedia = async () => { throw Object.assign(new Error(), { name: "NotAllowedError" }); };
  await env.voice.startRecording();
  assert.match(env.errors[1], /麦克风权限/);
  assert.equal(env.voice.capturing, false);
}));

test("normal recognizer disconnects restart; repeated rapid failures stop", () => browserTest(async (env) => {
  await env.voice.enableWake();
  env.clock.tick(5000);
  env.recognizers.at(-1).onend();
  env.clock.tick(400);
  assert.equal(env.recognizers.length, 2);
  for (let count = 0; count < 4; count += 1) {
    env.recognizers.at(-1).onend();
    env.clock.tick(400);
  }
  await flush();
  assert.equal(env.voice.wakeEnabled, false);
  assert.match(env.errors[0], /反复中断/);
}));

test("wake resumes when a playback blocker clears during recognizer shutdown", () => browserTest(async (env) => {
  await env.voice.enableWake();
  env.voice.setBlocked(true);
  env.voice.setBlocked(false);
  await flush();
  assert.equal(env.voice.phase, "listening");
}));

test("the configured wake phrase is used by the live recognition callback and status", () => browserTest(async (env) => {
  await env.voice.enableWake();
  env.voice.setWakePhrase("你好小童");
  assert.match(env.voice.status, /你好小童/);
  env.recognizers[0].result("你好迦童");
  await flush();
  assert.equal(env.voice.recording, false);
  env.recognizers[0].result("你好，小童");
  await flush();
  assert.equal(env.voice.recording, true);
}));

test("recognition alternatives and split results can wake 童童大王", () => browserTest(async (env) => {
  env.voice.setWakePhrase("童童大王");
  await env.voice.enableWake();
  env.recognizers[0].onresult({ results: [[{ transcript: "彤彤" }], [{ transcript: "大王" }]] });
  await flush();
  assert.equal(env.voice.recording, true);
  assert.equal(env.voice.lastHeard, "彤彤大王");
}));

test("wake acknowledgement finishes before microphone recording starts", () => browserTest(async (env) => {
  let finishReply;
  env.voice.onWake = ({ signal, audioContext }) => {
    assert.equal(signal.aborted, false);
    assert.equal(audioContext.state, "running");
    return new Promise((resolve) => { finishReply = resolve; });
  };
  await env.voice.enableWake();
  env.recognizers[0].result("你好迦童");
  await flush();
  assert.equal(env.voice.phase, "greeting");
  assert.equal(env.voice.recognition, null);
  assert.equal(env.streams.length, 0, "the greeting must not be captured by the microphone");
  assert.equal(env.voice.capturing, true, "composer actions stay locked during the reply");
  finishReply();
  await flush();
  assert.equal(env.voice.recording, true);
  assert.equal(env.streams.length, 1);
}));

test("turning wake off cancels a pending greeting and prevents late microphone startup", () => browserTest(async (env) => {
  let finishReply;
  let replySignal;
  env.voice.onWake = ({ signal }) => { replySignal = signal; return new Promise((resolve) => { finishReply = resolve; }); };
  await env.voice.enableWake();
  env.recognizers[0].result("你好迦童");
  await flush();
  env.voice.disableWake();
  assert.equal(replySignal.aborted, true);
  finishReply();
  await flush();
  assert.equal(env.voice.phase, "idle");
  assert.equal(env.streams.length, 0);
}));

test("hiding the page interrupts the greeting and restores only wake listening on return", () => browserTest(async (env) => {
  let finishReply;
  let replySignal;
  env.voice.onWake = ({ signal }) => { replySignal = signal; return new Promise((resolve) => { finishReply = resolve; }); };
  await env.voice.enableWake();
  env.recognizers[0].result("你好迦童");
  await flush();
  env.voice.setHidden(true);
  assert.equal(replySignal.aborted, true);
  finishReply();
  await flush();
  env.voice.setHidden(false);
  assert.equal(env.voice.phase, "listening");
  assert.equal(env.streams.length, 0);
}));

test("greeting playback failure reports a notice and still allows the voice question", () => browserTest(async (env) => {
  env.voice.onWake = async () => { throw new Error("test playback failure"); };
  await env.voice.enableWake();
  env.recognizers[0].result("你好迦童");
  await flush();
  assert.equal(env.voice.recording, true);
  assert.match(env.notices[0], /应答语音播放失败/);
}));

test("microphone disconnection cancels audio and leaves wake mode recoverable", () => browserTest(async (env) => {
  await env.voice.enableWake();
  env.recognizers[0].result("你好迦童");
  await flush();
  env.streams[0].getAudioTracks()[0].dispatchEvent(new Event("ended"));
  await flush();
  assert.equal(env.voice.capturing, false);
  assert.equal(env.voice.wakeEnabled, false);
  assert.equal(env.recordings.length, 0);
  assert.match(env.errors[0], /麦克风已断开/);
  await env.voice.enableWake();
  assert.equal(env.voice.phase, "listening");
}));

test("hiding during manual recording also closes the audio context", () => browserTest(async (env) => {
  await env.voice.startRecording();
  env.voice.setHidden(true);
  await flush();
  assert.equal(env.contexts[0].state, "closed");
  assert.equal(env.streams[0].getTracks()[0].stopped, true);
  assert.equal(env.recordings.length, 0);
}));

test("a stalled browser wake startup reports an error instead of showing false readiness", () => browserTest(async (env) => {
  env.voice.Recognition = class {
    start() {}
    abort() {}
  };
  await env.voice.enableWake();
  assert.equal(env.voice.phase, "idle");
  env.clock.tick(10_000);
  assert.equal(env.voice.wakeEnabled, false);
  assert.match(env.errors[0], /启动超时/);
}));
