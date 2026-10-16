const CHAT_KEY = "shiyi-chat-v1";
const MODEL_KEY = "shiyi-model-v1";
const $ = (selector) => document.querySelector(selector);
const messageList = $("#message-list");
const chatScroll = $("#chat-scroll");
const input = $("#message-input");
const sendButton = $("#send-button");
const microphoneButton = $("#microphone-button");
const voiceStatus = $("#voice-status");
const welcome = $("#welcome");
const toastRegion = $("#toast-region");

let config = null;
let messages = loadChat();
let memorySearchTimer = null;
let memoryRequestId = 0;
let memoryHasMore = false;
let memoryPage = 1;
let busy = false;
let mediaRecorder = null;
let microphoneStream = null;
let recordingChunks = [];
let recordingTimer = null;
let voiceProcessing = false;
let activeAudio = null;
let activeSpeechMessage = null;
let activeStreamAudioUrl = null;
let streamAudioQueue = [];
let streamAudioPlaying = false;
let streamSpeechCancelled = false;
let streamSpeechWarningShown = false;
const speechUrls = new WeakMap();
const MAX_RECORDING_MS = 120_000;

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
  updateComposerControls();
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
    playStreamAudioQueue();
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
}

async function sendMessage(raw, options) {
  options = options || {};
  const text = String(raw || input.value).trim();
  if (!text || busy) return;
  const priorMessages = messages.slice(-24).map((item) => ({ role: item.role, content: item.content }));
  stopStreamAudio();
  if (activeAudio) {
    activeAudio.pause();
    activeAudio = null;
    activeSpeechMessage = null;
  }
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
  voiceStatus.replaceChildren();
  if (message) {
    voiceStatus.textContent = message;
  } else {
    const mark = document.createElement("span");
    mark.className = "tiny-memory";
    mark.textContent = "✳";
    voiceStatus.append(mark, document.createTextNode(" 重要内容会自动整理进记忆"));
  }
  voiceStatus.classList.toggle("voice-status-active", Boolean(active));
}

function updateComposerControls() {
  const recording = Boolean(mediaRecorder && mediaRecorder.state === "recording");
  sendButton.disabled = busy || voiceProcessing || recording;
  input.disabled = busy || voiceProcessing || recording;
  microphoneButton.disabled = busy || voiceProcessing;
  microphoneButton.classList.toggle("voice-recording", recording);
  microphoneButton.setAttribute("aria-label", recording ? "停止录音并识别" : "开始录音");
  microphoneButton.title = recording ? "停止录音并识别" : "开始录音";
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;
  window.clearTimeout(recordingTimer);
  voiceProcessing = true;
  updateVoiceStatus("正在识别语音…", true);
  mediaRecorder.stop();
  updateComposerControls();
}

async function transcribeRecording(blob) {
  try {
    const response = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": blob.type || "application/octet-stream" },
      body: blob
    });
    let payload = {};
    try { payload = await response.json(); } catch (_) { payload = {}; }
    if (!response.ok) throw new Error(payload.error || "语音识别失败，请稍后重试。");
    const transcript = String(payload.text || "").trim();
    if (!transcript) throw new Error("没有识别到语音内容，请再试一次。");
    voiceProcessing = false;
    input.value = transcript;
    resizeInput();
    updateVoiceStatus("识别完成，正在发送…", true);
    updateComposerControls();
    await sendMessage(transcript, { speakResponse: true, focus: false });
    updateVoiceStatus("", false);
  } catch (error) {
    voiceProcessing = false;
    updateComposerControls();
    updateVoiceStatus("", false);
    showToast(error.message, "error");
  }
}

async function toggleRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    stopRecording();
    return;
  }
  if (busy || voiceProcessing) return;
  if (!window.isSecureContext) {
    showToast("浏览器只允许在 HTTPS 或 localhost 页面使用麦克风。", "error");
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    showToast("当前浏览器不支持网页录音，请更新浏览器后重试。", "error");
    return;
  }

  voiceProcessing = true;
  updateVoiceStatus("正在申请麦克风权限…", true);
  updateComposerControls();
  try {
    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    const mimeTypes = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
    const mimeType = mimeTypes.find((type) => MediaRecorder.isTypeSupported(type));
    mediaRecorder = mimeType ? new MediaRecorder(microphoneStream, { mimeType: mimeType }) : new MediaRecorder(microphoneStream);
    recordingChunks = [];
    const recorder = mediaRecorder;
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size) recordingChunks.push(event.data);
    });
    recorder.addEventListener("stop", () => {
      window.clearTimeout(recordingTimer);
      if (microphoneStream) microphoneStream.getTracks().forEach((track) => track.stop());
      microphoneStream = null;
      mediaRecorder = null;
      const blob = new Blob(recordingChunks, { type: recorder.mimeType || "audio/webm" });
      recordingChunks = [];
      if (!blob.size) {
        voiceProcessing = false;
        updateComposerControls();
        updateVoiceStatus("", false);
        showToast("没有录到声音，请重新录制。", "error");
        return;
      }
      transcribeRecording(blob);
    });
    recorder.start();
    voiceProcessing = false;
    updateVoiceStatus("正在录音 · 再点麦克风结束", true);
    updateComposerControls();
    recordingTimer = window.setTimeout(() => {
      showToast("录音已达到 2 分钟上限，正在识别。", "warning");
      stopRecording();
    }, MAX_RECORDING_MS);
  } catch (error) {
    if (microphoneStream) microphoneStream.getTracks().forEach((track) => track.stop());
    microphoneStream = null;
    mediaRecorder = null;
    voiceProcessing = false;
    updateComposerControls();
    updateVoiceStatus("", false);
    const message = error && error.name === "NotAllowedError"
      ? "麦克风权限未开启，请在浏览器设置中允许访问麦克风。"
      : "无法启动麦克风，请检查设备连接或浏览器权限。";
    showToast(message, "error");
  }
}

async function playSpeech(message, button, automatic) {
  if (!message || !message.content) return;
  stopStreamAudio();
  if (activeAudio && activeSpeechMessage === message) {
    if (!activeAudio.paused) {
      activeAudio.pause();
      return;
    }
    try { await activeAudio.play(); return; } catch (_) {}
  }
  if (activeAudio) activeAudio.pause();
  if (button) {
    button.disabled = true;
    button.innerHTML = '<span>◌</span> 正在合成…';
  }
  try {
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
    const audio = new Audio(url);
    activeAudio = audio;
    activeSpeechMessage = message;
    audio.addEventListener("ended", () => {
      if (activeAudio === audio) {
        activeAudio = null;
        activeSpeechMessage = null;
      }
    }, { once: true });
    await audio.play();
  } catch (error) {
    if (automatic) {
      showToast("回答文字已显示，但浏览器没有自动播放语音；点回答下方“朗读回答”即可播放。", "warning");
    } else {
      showToast(error.message, "error");
    }
  } finally {
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
      hint.textContent = "请在 .env 填写 " + missing.join(" 和 ");
      hint.classList.remove("service-ready");
    }
    $("#cloudflare-dot").classList.toggle("connected", config.cloudflare_ready);
    $("#memory-summary").textContent = config.mem0_ready ? "记忆由 Mem0 云端管理" : "配置 Mem0 Key 后即可连接";
  } catch (error) {
    $("#service-hint").textContent = error.message;
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

renderChat();
loadConfig();
