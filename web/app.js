import { VoiceInputController } from "./voice.mjs?v=wake-reply-3";

const CHAT_KEY = "shiyi-chat-v1";
const MODEL_KEY = "shiyi-model-v1";
const $ = (selector) => document.querySelector(selector);
const messageList = $("#message-list");
const chatScroll = $("#chat-scroll");
const input = $("#message-input");
const sendButton = $("#send-button");
const microphoneButton = $("#microphone-button");
const voiceStatus = $("#voice-status");
const wakeButton = $("#wake-button");
const silenceTimeout = $("#silence-timeout");
const settingsDialog = $("#settings-dialog");
const settingsForm = $("#settings-form");
const settingsButton = $("#open-settings");
const welcome = $("#welcome");
const toastRegion = $("#toast-region");

let config = null;
let wakeReplyText = "你好，主人您有什么吩咐";
let wakeReplyVoice = "zh-CN-XiaoxiaoNeural";
let wakeReplyCache = null;
let messages = loadChat();
let memorySearchTimer = null;
let memoryRequestId = 0;
let memoryHasMore = false;
let memoryPage = 1;
let busy = false;
let settingsOpen = false;
let settingsLoading = false;
let settingsSaving = false;
let settingsRequestId = 0;
let settingsToken = "";
let settingsSecrets = {};
let voiceProcessing = false;
let voiceMessage = "";
let voiceMessageActive = false;
let speechPreparing = false;
let speechRequestId = 0;
let activeAudio = null;
let activeSpeechMessage = null;
let activeStreamAudioUrl = null;
let streamAudioQueue = [];
let streamAudioPlaying = false;
let streamSpeechCancelled = false;
let streamSpeechWarningShown = false;
let streamAudioTask = null;
let speechUrls = new WeakMap();
const voice = new VoiceInputController({
  onChange: () => { updateComposerControls(); renderVoiceStatus(); },
  onRecording: (blob) => { transcribeRecording(blob); },
  onError: (message) => showToast(message, "error"),
  onNotice: (message) => showToast(message, "warning"),
  onWake: playWakeReply
});

function applyVoiceConfig(payload) {
  voice.setWakePhrase(payload.wake_phrase || "你好迦童");
  const text = payload.wake_reply_text || "你好，主人您有什么吩咐";
  const voiceName = payload.tts_voice || "zh-CN-XiaoxiaoNeural";
  if (text !== wakeReplyText || voiceName !== wakeReplyVoice) {
    wakeReplyCache?.controller.abort();
    wakeReplyCache = null;
  }
  wakeReplyText = text;
  wakeReplyVoice = voiceName;
  updateWakeHint();
}

function prepareWakeReplyAudio() {
  const key = JSON.stringify([wakeReplyText, wakeReplyVoice]);
  if (wakeReplyCache?.key === key) return wakeReplyCache.promise;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  const entry = { key, controller, promise: null };
  entry.promise = (async () => {
    const response = await fetch("/api/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: wakeReplyText }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error("唤醒应答语音合成失败。");
    const data = await response.arrayBuffer();
    if (!data.byteLength) throw new Error("唤醒应答语音为空。");
    return data;
  })().catch((error) => {
    if (wakeReplyCache === entry) wakeReplyCache = null;
    throw error;
  }).finally(() => window.clearTimeout(timeout));
  wakeReplyCache = entry;
  return entry.promise;
}

async function playWakeReply({ signal, audioContext }) {
  showView("chat");
  const encoded = await prepareWakeReplyAudio();
  if (signal.aborted) return;
  // decodeAudioData may detach its input; keep the cached audio reusable.
  const buffer = await audioContext.decodeAudioData(encoded.slice(0));
  if (signal.aborted) return;
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      source.onended = null;
      source.disconnect();
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      try { source.stop(); } catch (_) {}
      finish(new DOMException("唤醒应答已取消", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    source.onended = () => finish();
    if (signal.aborted) { abort(); return; }
    try { source.start(); } catch (error) { finish(error); }
  });
}

function loadChat() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CHAT_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => item && ["user", "assistant"].includes(item.role) && typeof item.content === "string") : [];
  } catch (_) {
    return [];
  }
}

function saveChat() {
  localStorage.setItem(CHAT_KEY, JSON.stringify(messages.slice(-100).map(({ role, content, time }) => ({ role, content, time }))));
}

async function api(path, options) {
  const response = await fetch(path, Object.assign({ headers: { "Content-Type": "application/json" } }, options || {}));
  let payload = {};
  try {
    payload = await response.json();
  } catch (_) {
    payload = {};
  }
  if (!response.ok) {
    throw new Error(payload.error || "请求失败，请稍后再试。");
  }
  return payload;
}

function showToast(message, kind) {
  const node = document.createElement("div");
  node.className = "toast" + (kind ? " toast-" + kind : "");
  node.textContent = message;
  toastRegion.appendChild(node);
  requestAnimationFrame(() => node.classList.add("toast-visible"));
  window.setTimeout(() => {
    node.classList.remove("toast-visible");
    window.setTimeout(() => node.remove(), 250);
  }, 3400);
}

function renderChat() {
  messageList.replaceChildren();
  welcome.classList.toggle("hidden", messages.length > 0);
  messages.forEach((message, index) => {
    const row = document.createElement("article");
    row.className = "message-row message-" + message.role;
    const avatar = document.createElement("div");
    avatar.className = "message-avatar " + (message.role === "assistant" ? "assistant-avatar" : "user-avatar");
    avatar.textContent = message.role === "assistant" ? "✳" : "我";
    const content = document.createElement("div");
    content.className = "message-content";
    const meta = document.createElement("div");
    meta.className = "message-meta";
    const name = document.createElement("strong");
    name.textContent = message.role === "assistant" ? "拾忆" : "你";
    meta.appendChild(name);
    const stamp = document.createElement("span");
    stamp.textContent = message.time ? formatTime(message.time) : "";
    meta.appendChild(stamp);
    const text = document.createElement("div");
    text.className = "message-text";
    text.textContent = message.content;
    content.append(meta, text);
    if (message.role === "user" || message.role === "assistant") {
      const controls = document.createElement("div");
      controls.className = "message-controls";
      if (message.role === "assistant" && !message.streaming) {
        const speak = document.createElement("button");
        speak.className = "message-action speak-action";
        speak.type = "button";
        speak.innerHTML = '<span>◖))</span> 朗读回答';
        speak.title = "使用 Microsoft Edge 语音播放这条回答";
        speak.addEventListener("click", () => playSpeech(message, speak, false));
        controls.appendChild(speak);
      }
      if (!message.streaming) {
        const remember = document.createElement("button");
        remember.className = "message-action";
        remember.type = "button";
        remember.innerHTML = '<span>✳</span> 记住这条';
        remember.title = "将这条内容原文保存到长期记忆";
        remember.addEventListener("click", () => rememberMessage(index, remember));
        controls.appendChild(remember);
        content.appendChild(controls);
      }
    }
    if (message.role === "assistant") {
      row.append(avatar, content);
    } else {
      row.append(content, avatar);
    }
    messageList.appendChild(row);
  });
  scrollChatToBottom();
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function scrollChatToBottom() {
  requestAnimationFrame(() => {
    chatScroll.scrollTop = chatScroll.scrollHeight;
  });
}

function setBusy(value) {
  busy = value;
  syncVoiceState();
  sendButton.classList.toggle("sending", value);
  if (value) {
    const typing = document.createElement("div");
    typing.id = "typing-indicator";
    typing.className = "message-row message-assistant typing-row";
    typing.innerHTML = '<div class="message-avatar assistant-avatar">✳</div><div class="typing-bubble"><span></span><span></span><span></span><small>正在思考…</small></div>';
    messageList.appendChild(typing);
    scrollChatToBottom();
  } else {
    const typing = $("#typing-indicator");
    if (typing) typing.remove();
  }
}

function updateTypingStatus(message) {
  const label = $("#typing-indicator small");
  if (label && message) label.textContent = message;
}

function finalizeStreamMessage(message) {
  if (!message || !message.streaming) return;
  message.streaming = false;
  saveChat();
  renderChat();
}

function handleStreamEvent(eventName, payload, state) {
  if (eventName === "status") {
    updateTypingStatus(payload.message);
  } else if (eventName === "delta") {
    const piece = typeof payload.text === "string" ? payload.text : "";
    if (!piece) return;
    const typing = $("#typing-indicator");
    if (typing) typing.remove();
    if (!state.answerMessage) {
      state.answerMessage = {
        role: "assistant",
        content: "",
        time: new Date().toISOString(),
        streaming: true
      };
      messages.push(state.answerMessage);
      renderChat();
      state.answerTextElement = messageList.lastElementChild.querySelector(".message-text");
    }
    state.answerMessage.content += piece;
    state.answerTextElement.textContent = state.answerMessage.content;
    scrollChatToBottom();
  } else if (eventName === "audio") {
    enqueueStreamAudio(payload.audio);
  } else if (eventName === "speech_error") {
    if (!streamSpeechWarningShown) {
      streamSpeechWarningShown = true;
      showToast("文字回答会正常显示，但分段语音合成失败；可点回答下方“朗读回答”重试。", "warning");
    }
  } else if (eventName === "text_done") {
    if (!state.answerMessage && typeof payload.answer === "string" && payload.answer) {
      state.answerMessage = {
        role: "assistant",
        content: payload.answer,
        time: new Date().toISOString(),
        streaming: true
      };
      messages.push(state.answerMessage);
    } else if (state.answerMessage && typeof payload.answer === "string") {
      state.answerMessage.content = payload.answer;
    }
    finalizeStreamMessage(state.answerMessage);
    state.textDone = true;
  } else if (eventName === "error") {
    state.error = payload.error || "回答生成失败，请稍后重试。";
  } else if (eventName === "complete") {
    state.complete = payload;
    finalizeStreamMessage(state.answerMessage);
  }
}

function decodeStreamBlock(block, state) {
  let eventName = "message";
  const data = [];
  block.split("\n").forEach((line) => {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trim());
  });
  if (!data.length) return;
  try {
    handleStreamEvent(eventName, JSON.parse(data.join("\n")), state);
  } catch (error) {
    console.error("Could not process streaming response event", error);
  }
}

function stopStreamAudio() {
  streamSpeechCancelled = true;
  streamAudioQueue.forEach((url) => URL.revokeObjectURL(url));
  streamAudioQueue = [];
  if (activeAudio && activeStreamAudioUrl) {
    activeAudio.pause();
    URL.revokeObjectURL(activeStreamAudioUrl);
    activeAudio = null;
    activeSpeechMessage = null;
    activeStreamAudioUrl = null;
  }
}

function enqueueStreamAudio(encodedAudio) {
  if (!encodedAudio || streamSpeechCancelled) return;
  try {
    const raw = atob(encodedAudio);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
    streamAudioQueue.push(url);
    if (!streamAudioPlaying) streamAudioTask = playStreamAudioQueue();
  } catch (_) {
    if (!streamSpeechWarningShown) {
      streamSpeechWarningShown = true;
      showToast("收到的语音片段无法播放；文字回答仍然完整。", "warning");
    }
  }
}

async function playStreamAudioQueue() {
  if (streamAudioPlaying || streamSpeechCancelled) return;
  streamAudioPlaying = true;
  syncVoiceState();
  while (streamAudioQueue.length && !streamSpeechCancelled) {
    const url = streamAudioQueue.shift();
    const audio = new Audio(url);
    activeAudio = audio;
    activeSpeechMessage = null;
    activeStreamAudioUrl = url;
    let blocked = false;
    await new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        resolve();
      };
      audio.addEventListener("ended", finish, { once: true });
      audio.addEventListener("error", finish, { once: true });
      audio.addEventListener("pause", finish, { once: true });
      audio.play().catch(() => {
        blocked = true;
        finish();
      });
    });
    if (activeAudio === audio) activeAudio = null;
    if (activeStreamAudioUrl === url) activeStreamAudioUrl = null;
    URL.revokeObjectURL(url);
    if (blocked && !streamSpeechCancelled) {
      stopStreamAudio();
      if (!streamSpeechWarningShown) {
        streamSpeechWarningShown = true;
        showToast("回答文字已显示，但浏览器未允许自动播放语音；点回答下方“朗读回答”即可播放。", "warning");
      }
    }
  }
  streamAudioPlaying = false;
  syncVoiceState();
}

async function sendMessage(raw, options) {
  options = options || {};
  const text = String(raw || input.value).trim();
  if (!text || busy || voiceProcessing || voice.capturing || settingsOpen) return;
  const priorMessages = messages.slice(-24).map((item) => ({ role: item.role, content: item.content }));
  stopAudioPlayback();
  messages.push({ role: "user", content: text, time: new Date().toISOString() });
  saveChat();
  renderChat();
  input.value = "";
  resizeInput();
  setBusy(true);
  streamSpeechCancelled = false;
  streamSpeechWarningShown = false;
  const state = { answerMessage: null, answerTextElement: null, textDone: false, complete: null, error: null };
  try {
    const model = $("#model-select").value;
    const response = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
      body: JSON.stringify({ message: text, history: priorMessages, model: model, speak: Boolean(options.speakResponse) })
    });
    if (!response.ok) {
      let payload = {};
      try { payload = await response.json(); } catch (_) {}
      throw new Error(payload.error || "请求失败，请稍后再试。");
    }
    if (!response.body) throw new Error("浏览器不支持流式响应，请更新浏览器后重试。");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        decodeStreamBlock(buffer.slice(0, boundary), state);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) decodeStreamBlock(buffer, state);
    finalizeStreamMessage(state.answerMessage);
    if (state.error) throw new Error(state.error);
    if (!state.complete) throw new Error("连接在回答完成前中断了；已收到的文字仍保留在对话中。");
    if (state.complete.memory_warning) showToast(state.complete.memory_warning, "warning");
    else if (state.complete.memory_write && state.complete.memory_write.status === "PENDING") showToast("已发送到 Mem0，正在整理长期记忆。");
    window.setTimeout(() => {
      if ($("#memories-view").classList.contains("hidden") === false) loadMemories();
    }, 2200);
  } catch (error) {
    finalizeStreamMessage(state.answerMessage);
    showToast(error.message, "error");
  } finally {
    setBusy(false);
  }
  if (options.focus !== false) input.focus();
}

function updateVoiceStatus(message, active) {
  voiceMessage = message || "";
  voiceMessageActive = Boolean(active);
  renderVoiceStatus();
}

function renderVoiceStatus() {
  let message = voiceMessage || voice.status;
  if (!voiceMessage && voice.wakeEnabled && settingsOpen) message = "设置已打开 · 关闭后恢复唤醒";
  else if (!voiceMessage && voice.wakeEnabled && busy) message = "正在回答 · 结束后恢复唤醒";
  else if (!voiceMessage && voice.wakeEnabled && (speechPreparing || streamAudioPlaying || (activeAudio && !activeAudio.paused))) {
    message = "正在播放回答 · 唤醒监听已暂停";
  }
  voiceStatus.replaceChildren();
  if (message) voiceStatus.textContent = message;
  else {
    const mark = document.createElement("span");
    mark.className = "tiny-memory";
    mark.textContent = "✳";
    voiceStatus.append(mark, document.createTextNode(" 重要内容会自动整理进记忆"));
  }
  voiceStatus.classList.toggle("voice-status-active", voiceMessageActive || voice.capturing);
  const heard = $("#wake-heard");
  heard.textContent = voice.lastHeard && voice.wakeEnabled ? `刚才听到：${voice.lastHeard}` : "";
  heard.classList.toggle("hidden", !heard.textContent);
}

function updateComposerControls() {
  sendButton.disabled = busy || voiceProcessing || voice.capturing;
  input.disabled = busy || voiceProcessing || voice.capturing;
  microphoneButton.disabled = busy || voiceProcessing || (voice.capturing && !voice.recording);
  microphoneButton.classList.toggle("voice-recording", voice.recording);
  const label = voice.recording ? "停止录音并识别" : "开始录音，静音后自动结束";
  microphoneButton.setAttribute("aria-label", label);
  microphoneButton.title = label;
  silenceTimeout.disabled = voice.capturing;
  wakeButton.setAttribute("aria-pressed", String(voice.wakeEnabled));
  wakeButton.classList.toggle("wake-listening", voice.phase === "listening");
  $("#wake-button-label").textContent = voice.wakeEnabled ? "关闭语音唤醒" : "开启语音唤醒";
  // Always allow turning wake mode off, including while recording.
  wakeButton.disabled = !voice.wakeEnabled && (!voice.canWake || busy || voiceProcessing || voice.capturing);
  settingsButton.disabled = busy || voiceProcessing || voice.capturing;
}

function syncVoiceState() {
  voice.setBlocked(settingsOpen || busy || voiceProcessing || speechPreparing || streamAudioPlaying || streamAudioQueue.length > 0 || Boolean(activeAudio && !activeAudio.paused));
  updateComposerControls();
  renderVoiceStatus();
}

function stopAudioPlayback() {
  speechRequestId += 1;
  speechPreparing = false;
  stopStreamAudio();
  if (activeAudio) activeAudio.pause();
  activeAudio = null;
  activeSpeechMessage = null;
}

async function transcribeRecording(blob) {
  voiceProcessing = true;
  updateVoiceStatus("正在识别语音…", true);
  syncVoiceState();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": blob.type || "application/octet-stream" },
      body: blob,
      signal: controller.signal
    });
    let payload = {};
    try { payload = await response.json(); } catch (_) { payload = {}; }
    if (!response.ok) throw new Error(payload.error || "语音识别失败，请稍后重试。");
    const transcript = String(payload.text || "").trim();
    if (!transcript) throw new Error("没有识别到语音内容，请再试一次。");
    window.clearTimeout(timeout);
    voiceProcessing = false;
    input.value = transcript;
    resizeInput();
    updateVoiceStatus("", false);
    // sendMessage sets busy synchronously so wake cannot restart between steps.
    await sendMessage(transcript, { speakResponse: true, focus: false });
  } catch (error) {
    showToast(error.name === "AbortError" ? "语音识别超时，请检查网络后重试。" : error.message, "error");
  } finally {
    window.clearTimeout(timeout);
    voiceProcessing = false;
    updateVoiceStatus("", false);
    syncVoiceState();
  }
}

async function toggleRecording() {
  if (voice.recording) { voice.stopRecording(); return; }
  if (busy || voiceProcessing || voice.capturing || settingsOpen) return;
  stopAudioPlayback();
  syncVoiceState();
  if (streamAudioTask) await streamAudioTask;
  await voice.startRecording();
}

async function playSpeech(message, button, automatic) {
  if (!message || !message.content || voice.capturing || voiceProcessing || settingsOpen) return;
  if (activeAudio && activeSpeechMessage === message && !activeAudio.paused) {
    activeAudio.pause();
    return;
  }
  stopAudioPlayback();
  const requestId = ++speechRequestId;
  speechPreparing = true;
  syncVoiceState();
  if (button) {
    button.disabled = true;
    button.innerHTML = '<span>◌</span> 正在合成…';
  }
  try {
    await voice.stopWake();
    if (streamAudioTask) await streamAudioTask;
    let url = speechUrls.get(message);
    if (!url) {
      const response = await fetch("/api/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: message.content })
      });
      if (!response.ok) {
        let payload = {};
        try { payload = await response.json(); } catch (_) { payload = {}; }
        throw new Error(payload.error || "语音合成失败，请稍后重试。");
      }
      url = URL.createObjectURL(await response.blob());
      speechUrls.set(message, url);
    }
    if (requestId !== speechRequestId) return;
    const audio = new Audio(url);
    activeAudio = audio;
    activeSpeechMessage = message;
    const finish = () => {
      if (activeAudio === audio) {
        activeAudio = null;
        activeSpeechMessage = null;
        syncVoiceState();
      }
    };
    for (const event of ["ended", "error", "pause"]) audio.addEventListener(event, finish, { once: true });
    await audio.play();
  } catch (error) {
    if (requestId !== speechRequestId) return;
    activeAudio = null;
    activeSpeechMessage = null;
    showToast(automatic ? "回答文字已显示，但浏览器没有自动播放语音；点回答下方“朗读回答”即可播放。" : error.message, "error");
  } finally {
    if (requestId === speechRequestId) {
      speechPreparing = false;
      syncVoiceState();
    }
    if (button) {
      button.disabled = false;
      button.innerHTML = '<span>◖))</span> 朗读回答';
    }
  }
}

async function rememberMessage(index, button) {
  const message = messages[index];
  if (!message || button.disabled) return;
  button.disabled = true;
  button.classList.add("action-pending");
  try {
    await api("/api/memories/remember", {
      method: "POST",
      body: JSON.stringify({ content: message.content })
    });
    showToast("已按原文加入长期记忆。");
    window.setTimeout(() => {
      if (!$("#memories-view").classList.contains("hidden")) loadMemories();
    }, 1800);
  } catch (error) {
    showToast(error.message, "error");
    button.disabled = false;
    button.classList.remove("action-pending");
  }
}

function renderModelOptions() {
  if (!config) return;
  const select = $("#model-select");
  select.replaceChildren();
  config.models.forEach((model) => {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.name + " · " + model.note;
    select.appendChild(option);
  });
  const saved = localStorage.getItem(MODEL_KEY);
  const desired = saved || config.default_model;
  select.value = config.models.some((model) => model.id === desired) ? desired : config.default_model;
  if (!select.value && config.models.length) select.value = config.models[0].id;
  select.addEventListener("change", () => localStorage.setItem(MODEL_KEY, select.value));
}

async function loadConfig() {
  try {
    config = await api("/api/config");
    applyVoiceConfig(config);
    renderModelOptions();
    $("#nvidia-dot").classList.toggle("connected", config.nvidia_ready);
    $("#mem0-dot").classList.toggle("connected", config.mem0_ready);
    const hint = $("#service-hint");
    if (config.nvidia_ready && config.mem0_ready) {
      hint.textContent = config.cloudflare_ready
        ? "NVIDIA、Mem0 和 Cloudflare 已配置"
        : "对话已就绪；填写 Cloudflare 配置以启用语音输入";
      hint.classList.add("service-ready");
    } else {
      const missing = [];
      if (!config.nvidia_ready) missing.push("NVIDIA_API_KEY");
      if (!config.mem0_ready) missing.push("MEM0_API_KEY");
      if (!config.cloudflare_ready) missing.push("CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN（语音识别）");
      hint.textContent = "请在设置中填写 " + missing.join(" 和 ");
      hint.classList.remove("service-ready");
    }
    $("#cloudflare-dot").classList.toggle("connected", config.cloudflare_ready);
    $("#memory-summary").textContent = config.mem0_ready ? "记忆由 Mem0 云端管理" : "配置 Mem0 Key 后即可连接";
  } catch (error) {
    $("#service-hint").textContent = error.message;
  }
}

function updateWakeHint() {
  $("#wake-hint").textContent = !voice.canWake
    ? (voice.supported ? "当前浏览器不支持语音唤醒，仍可点击麦克风录音，静音后自动结束。" : voice.supportError())
    : `开启后说“${voice.wakePhrase}”，应答播报完、看到录音提示后讲话。请保持页面在前台。`;
}

function settingsStatus(message, error = false) {
  const status = $("#settings-status");
  status.textContent = message;
  status.classList.toggle("settings-error", error);
}

function updateSettingsControls() {
  const pending = settingsLoading || settingsSaving;
  document.querySelectorAll("[data-setting]").forEach((field) => {
    const clear = field.dataset.secret && document.querySelector(`[data-clear-secret="${field.dataset.setting}"]`);
    field.disabled = pending || Boolean(clear && clear.checked);
  });
  document.querySelectorAll("[data-clear-secret]").forEach((field) => {
    field.disabled = pending || !settingsSecrets[field.dataset.clearSecret];
  });
  $("#save-settings").disabled = pending || !settingsToken;
  $("#save-settings").textContent = settingsSaving ? "正在保存…" : "保存设置";
  $("#close-settings").disabled = settingsSaving;
  settingsForm.setAttribute("aria-busy", String(pending));
}

function fillSettings(payload) {
  settingsSecrets = payload.secrets || {};
  if (payload.models) {
    const modelSelect = $("#setting-model");
    modelSelect.replaceChildren();
    payload.models.forEach((model) => {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.name;
      modelSelect.appendChild(option);
    });
  }
  document.querySelectorAll("[data-setting]").forEach((field) => {
    const key = field.dataset.setting;
    field.value = field.dataset.secret ? "" : String(payload.values[key] ?? "");
    if (field.dataset.secret) field.placeholder = settingsSecrets[key] ? "已配置，留空保留" : "尚未配置，请填写";
  });
  document.querySelectorAll("[data-clear-secret]").forEach((field) => { field.checked = false; });
}

async function openSettings() {
  if (busy || voiceProcessing || voice.capturing || settingsOpen) return;
  settingsOpen = true;
  settingsToken = "";
  settingsLoading = true;
  const requestId = ++settingsRequestId;
  stopAudioPlayback();
  syncVoiceState();
  settingsDialog.showModal();
  settingsStatus("正在读取配置…");
  updateSettingsControls();
  try {
    const payload = await api("/api/settings");
    if (requestId !== settingsRequestId) return;
    settingsToken = payload.csrf_token;
    fillSettings(payload);
    settingsStatus("保存后生效；修改端口需要重启服务。");
  } catch (error) {
    if (requestId === settingsRequestId) settingsStatus(error.message, true);
  } finally {
    if (requestId === settingsRequestId) {
      settingsLoading = false;
      updateSettingsControls();
    }
  }
}

async function saveSettings(event) {
  event.preventDefault();
  if (settingsLoading || settingsSaving || !settingsToken) return;
  const values = {};
  document.querySelectorAll("[data-setting]").forEach((field) => {
    if (!field.dataset.secret || field.value.trim()) values[field.dataset.setting] = field.value;
  });
  const clearSecrets = Array.from(document.querySelectorAll("[data-clear-secret]")).filter((field) => field.checked).map((field) => field.dataset.clearSecret);
  settingsSaving = true;
  settingsStatus("正在保存配置…");
  updateSettingsControls();
  try {
    const result = await api("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Settings-Token": settingsToken },
      body: JSON.stringify({ values, clear_secrets: clearSecrets })
    });
    // Refresh wake immediately even if the subsequent status request fails.
    applyVoiceConfig({ wake_phrase: result.values.WAKE_PHRASE, wake_reply_text: result.values.WAKE_REPLY_TEXT, tts_voice: result.values.TTS_VOICE });
    speechUrls = new WeakMap();
    localStorage.setItem(MODEL_KEY, result.values.NVIDIA_DEFAULT_MODEL);
    fillSettings(result);
    await loadConfig();
    if (!$("#memories-view").classList.contains("hidden")) loadMemories();
    settingsStatus(result.restart_required
      ? `已保存到 .env。请重启服务，并访问新端口 ${result.values.PORT}。`
      : "已保存到 .env，新配置已生效。");
  } catch (error) {
    settingsStatus(error.message, true);
  } finally {
    settingsSaving = false;
    updateSettingsControls();
  }
}

function showView(viewName) {
  const chatActive = viewName === "chat";
  $("#chat-view").classList.toggle("hidden", !chatActive);
  $("#memories-view").classList.toggle("hidden", chatActive);
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === viewName);
  });
  $("#current-section").textContent = chatActive ? "对话" : "记忆库";
  if (!chatActive) loadMemories();
}

function memoryArray(payload) {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload.results) ? payload.results : [];
}

function formatDate(value) {
  if (!value) return "刚刚";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(date);
}

function makeMemoryCard(memory) {
  const card = document.createElement("article");
  card.className = "memory-card";
  const top = document.createElement("div");
  top.className = "memory-card-top";
  const icon = document.createElement("span");
  icon.className = "memory-card-icon";
  icon.textContent = categoryIcon(memory.categories);
  const badge = document.createElement("span");
  badge.className = "memory-category";
  badge.textContent = categoryLabel(memory.categories);
  top.append(icon, badge);
  const date = document.createElement("time");
  date.className = "memory-date";
  date.textContent = formatDate(memory.updated_at || memory.created_at);
  top.appendChild(date);
  const text = document.createElement("p");
  text.className = "memory-card-text";
  text.textContent = String(memory.memory || memory.content || "（没有文本内容）");
  const footer = document.createElement("div");
  footer.className = "memory-card-footer";
  const source = document.createElement("span");
  source.className = "memory-source";
  source.innerHTML = '<span></span> 长期记忆';
  const forget = document.createElement("button");
  forget.className = "forget-button";
  forget.type = "button";
  forget.innerHTML = '<span>⌫</span> 忘记';
  forget.addEventListener("click", () => forgetMemory(memory.id, forget));
  footer.append(source, forget);
  card.append(top, text, footer);
  return card;
}

function categoryLabel(categories) {
  if (!Array.isArray(categories) || !categories.length) return "个人记忆";
  const map = {
    preferences: "偏好",
    food_preferences: "偏好",
    health: "个人背景",
    personal: "个人背景",
    goals: "长期目标",
    projects: "项目上下文",
    project: "项目上下文"
  };
  return map[String(categories[0]).toLowerCase()] || String(categories[0]).replaceAll("_", " ");
}

function categoryIcon(categories) {
  const label = categoryLabel(categories);
  if (label === "偏好") return "✦";
  if (label === "长期目标") return "◎";
  if (label === "项目上下文") return "↗";
  return "✳";
}

async function loadMemories(page, append) {
  const list = $("#memory-list");
  const empty = $("#memory-empty");
  const query = $("#memory-search").value.trim();
  const requestedPage = page || 1;
  const appendResults = Boolean(append && !query);
  const requestId = ++memoryRequestId;
  if (!appendResults) {
    list.classList.add("loading-list");
    $("#memory-summary").textContent = query ? "正在搜索记忆…" : "正在加载记忆…";
  }
  $("#load-more-memories").classList.add("hidden");
  try {
    const payload = query
      ? await api("/api/memories/search", { method: "POST", body: JSON.stringify({ query: query }) })
      : await api("/api/memories?page=" + requestedPage);
    if (requestId !== memoryRequestId) return;
    const items = memoryArray(payload);
    if (!appendResults) list.replaceChildren();
    items.forEach((memory) => list.appendChild(makeMemoryCard(memory)));
    const count = typeof payload.count === "number" ? payload.count : items.length;
    const displayedCount = list.querySelectorAll(".memory-card").length;
    $("#memory-count").textContent = String(query ? items.length : count);
    $("#memory-summary").textContent = query ? "找到 " + items.length + " 条相关记忆" : "已显示 " + displayedCount + " / " + count + " 条长期记忆";
    empty.classList.toggle("hidden", displayedCount !== 0);
    if (displayedCount === 0) {
      $("#memory-empty-title").textContent = query ? "没有找到相关记忆" : "这里还很安静";
      $("#memory-empty-copy").textContent = query
        ? "试试更短的关键词，或者换一种问法。"
        : "开始一段对话，告诉我你的偏好、长期目标或正在推进的项目。";
    }
    memoryPage = requestedPage;
    memoryHasMore = !query && Boolean(payload.next || (count > displayedCount && items.length > 0));
    $("#load-more-memories").classList.toggle("hidden", !memoryHasMore);
  } catch (error) {
    if (requestId !== memoryRequestId) return;
    if (appendResults) {
      showToast(error.message, "error");
      $("#load-more-memories").classList.toggle("hidden", !memoryHasMore);
    } else {
      list.replaceChildren();
      empty.classList.remove("hidden");
      $("#memory-empty-title").textContent = "暂时无法读取记忆";
      $("#memory-empty-copy").textContent = error.message;
      $("#memory-summary").textContent = "连接失败";
      $("#memory-count").textContent = "—";
    }
  } finally {
    if (requestId === memoryRequestId) list.classList.remove("loading-list");
  }
}

async function forgetMemory(memoryId, button) {
  if (!memoryId || button.disabled) return;
  button.disabled = true;
  try {
    await api("/api/memories/" + encodeURIComponent(memoryId), { method: "DELETE" });
    showToast("这条记忆已删除。");
    loadMemories();
  } catch (error) {
    button.disabled = false;
    showToast(error.message, "error");
  }
}

async function forgetAll() {
  if (!window.confirm("确定清空这个用户在 Mem0 中的全部长期记忆吗？这项操作无法撤销。")) return;
  const button = $("#clear-all");
  button.disabled = true;
  button.classList.add("button-loading");
  try {
    const result = await api("/api/memories/forget-all", { method: "POST", body: "{}" });
    showToast("已清空 " + (result.deleted || 0) + " 条记忆。");
    loadMemories();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
    button.classList.remove("button-loading");
  }
}

function resizeInput() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 180) + "px";
}

$("#send-button").addEventListener("click", () => sendMessage());
microphoneButton.addEventListener("click", toggleRecording);
settingsButton.addEventListener("click", openSettings);
settingsForm.addEventListener("submit", saveSettings);
$("#close-settings").addEventListener("click", () => { if (!settingsSaving) settingsDialog.close(); });
settingsDialog.addEventListener("cancel", (event) => { if (settingsSaving) event.preventDefault(); });
settingsDialog.addEventListener("close", () => {
  settingsOpen = false;
  settingsRequestId += 1;
  settingsToken = "";
  document.querySelectorAll('[data-secret="true"]').forEach((field) => { field.value = ""; });
  syncVoiceState();
});
document.querySelectorAll("[data-clear-secret]").forEach((checkbox) => {
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) document.querySelector(`[data-setting="${checkbox.dataset.clearSecret}"]`).value = "";
    updateSettingsControls();
  });
});
document.querySelectorAll("[data-setting]").forEach((field) => {
  field.addEventListener("input", () => settingsStatus("有未保存的修改。"));
  field.addEventListener("change", () => settingsStatus("有未保存的修改。"));
});
wakeButton.addEventListener("click", () => {
  if (voice.wakeEnabled) voice.disableWake();
  else {
    voice.enableWake();
    // Prepare the fixed reply while waiting, to avoid synthesis delay on wake.
    prepareWakeReplyAudio().catch(() => {});
  }
});
silenceTimeout.addEventListener("change", () => {
  voice.silenceMs = Number(silenceTimeout.value);
  renderVoiceStatus();
});
document.addEventListener("visibilitychange", () => voice.setHidden(document.hidden));
window.addEventListener("pagehide", () => voice.destroy());
window.addEventListener("pageshow", () => voice.setHidden(document.hidden));
input.addEventListener("input", resizeInput);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});
document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.view));
});
document.querySelectorAll(".suggestion").forEach((button) => {
  button.addEventListener("click", () => sendMessage(button.dataset.prompt));
});
$("#new-chat").addEventListener("click", () => {
  messages = [];
  saveChat();
  renderChat();
  showView("chat");
  input.focus();
});
$("#refresh-config").addEventListener("click", loadConfig);
$("#refresh-memories").addEventListener("click", () => loadMemories());
$("#load-more-memories").addEventListener("click", () => loadMemories(memoryPage + 1, true));
$("#clear-all").addEventListener("click", forgetAll);
$("#go-chat").addEventListener("click", () => showView("chat"));
$("#memory-search").addEventListener("input", () => {
  window.clearTimeout(memorySearchTimer);
  memorySearchTimer = window.setTimeout(loadMemories, 350);
});
$("#memory-search").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    window.clearTimeout(memorySearchTimer);
    loadMemories();
  }
});

updateWakeHint();
voice.setHidden(document.hidden);
syncVoiceState();
renderChat();
loadConfig();
