import { pinyin } from "./vendor/pinyin-pro.mjs";

// The wake recognizer is browser-provided; matching and endpointing run locally.
export const WAKE_PHRASE = "你好迦童";
const MAX_RECORDING_MS = 120_000;
const START_TIMEOUT_MS = 8_000;

function normalizeWakePhrase(text) {
  return String(text || "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

export function matchesWakePhrase(text, phrase = WAKE_PHRASE) {
  // Chinese recognizers often spell the uncommon name with these homophones.
  const normalized = normalizeWakePhrase(text);
  const keyword = normalizeWakePhrase(phrase);
  if (!keyword) return false;
  if (normalized.includes(keyword)) return true;
  if (keyword === normalizeWakePhrase(WAKE_PHRASE) && /你好[迦嘉佳家加伽][童同彤桐瞳]/u.test(normalized)) return true;
  if (!/\p{Script=Han}/u.test(keyword)) return false;
  // Match whole syllables so 西安 (xi/an) cannot match 先 (xian).
  const syllables = (value) => "\0" + pinyin(value, { toneType: "none", type: "array" }).join("\0") + "\0";
  return syllables(normalized).includes(syllables(keyword));
}

export class VoiceActivityDetector {
  constructor({ silenceMs = 1200, startTimeoutMs = START_TIMEOUT_MS, maxDurationMs = MAX_RECORDING_MS } = {}) {
    this.silenceMs = silenceMs;
    this.startTimeoutMs = startTimeoutMs;
    this.maxDurationMs = maxDurationMs;
    this.startedAt = null;
    this.speechSince = null;
    this.lastSpeechAt = null;
    this.noiseFloor = 0.003;
    this.hasSpeech = false;
    this.finished = false;
  }

  process(samples, now) {
    if (this.finished) return null;
    if (this.startedAt === null) this.startedAt = now;
    // Remove DC offset before measuring signal energy.
    let mean = 0;
    for (const sample of samples) mean += sample;
    mean /= samples.length || 1;
    let energy = 0;
    for (const sample of samples) energy += (sample - mean) ** 2;
    const rms = Math.sqrt(energy / (samples.length || 1));
    const threshold = Math.max(0.012, Math.min(0.06, this.noiseFloor * 3));
    if (rms >= threshold) {
      if (this.speechSince === null) this.speechSince = now;
      // Ignore isolated clicks; require at least 160 ms of sustained activity.
      if (now - this.speechSince >= 160) this.hasSpeech = true;
      if (this.hasSpeech) this.lastSpeechAt = now;
    } else {
      this.speechSince = null;
      this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
    }
    let reason = null;
    if (now - this.startedAt >= this.maxDurationMs) reason = this.hasSpeech ? "limit" : "no-speech";
    else if (this.hasSpeech && now - this.lastSpeechAt >= this.silenceMs) reason = "silence";
    else if (!this.hasSpeech && now - this.startedAt >= this.startTimeoutMs) reason = "no-speech";
    if (reason) this.finished = true;
    return reason;
  }
}

export class VoiceInputController {
  constructor({ onChange = () => {}, onRecording = () => {}, onError = () => {}, onNotice = () => {}, onWake = () => {} } = {}) {
    this.onChange = onChange;
    this.onRecording = onRecording;
    this.onError = onError;
    this.onNotice = onNotice;
    this.onWake = onWake;
    this.Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
    this.AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
    this.wakeEnabled = false;
    this.wakePhrase = WAKE_PHRASE;
    this.lastHeard = "";
    this.greetingAbort = null;
    this.blocked = false;
    this.hidden = false;
    this.phase = "idle";
    this.silenceMs = 1200;
    this.generation = 0;
    this.recognition = null;
    this.wakeFailures = 0;
    this.wakeTimer = null;
    this.wakeStartTimer = null;
    this.wakeStopping = null;
    this.audioContext = null;
    this.session = null;
  }

  get supported() {
    return Boolean(globalThis.isSecureContext && navigator.mediaDevices?.getUserMedia && globalThis.MediaRecorder && this.AudioContext);
  }

  get canWake() { return this.supported && Boolean(this.Recognition); }
  get capturing() { return ["greeting", "starting", "recording", "stopping"].includes(this.phase); }
  get recording() { return this.phase === "recording"; }

  get status() {
    if (this.phase === "greeting") return "已唤醒 · 正在回应，播报后开始录音";
    if (this.phase === "starting") return "正在准备麦克风…";
    if (this.phase === "recording") return `正在录音 · 静音 ${this.silenceMs / 1000} 秒自动结束`;
    if (this.phase === "stopping") return "正在结束录音…";
    if (!this.wakeEnabled) return "";
    if (this.hidden) return "页面已离开前台 · 唤醒已暂停";
    if (this.blocked) return "语音唤醒已暂停，处理完成后恢复";
    return this.phase === "listening" ? `等待唤醒 · 请说“${this.wakePhrase}”` : "正在连接唤醒识别…";
  }

  setWakePhrase(value) {
    const phrase = String(value || "").trim() || WAKE_PHRASE;
    if (this.wakePhrase !== phrase) this.lastHeard = "";
    this.wakePhrase = phrase;
    this.onChange();
  }

  setBlocked(value) {
    if (this.blocked === Boolean(value)) return;
    this.blocked = Boolean(value);
    if (this.blocked && this.phase === "greeting") this.cancelRecording();
    this.reconcileWake();
  }

  setHidden(value) {
    this.hidden = Boolean(value);
    if (this.hidden && this.capturing) this.cancelRecording();
    this.reconcileWake();
  }

  async enableWake() {
    if (!this.canWake) {
      this.onError(this.supported ? "当前浏览器不支持语音唤醒，请使用麦克风按钮录音。" : this.supportError());
      return;
    }
    this.wakeEnabled = true;
    this.wakeFailures = 0;
    const generation = ++this.generation;
    this.onChange();
    // Create/resume from the click gesture for mobile Web Audio policies.
    try {
      await this.prepareAudioContext();
      if (generation === this.generation) this.reconcileWake();
    } catch (error) {
      if (generation !== this.generation) return;
      this.disableWake();
      this.onError(error.message);
    }
  }

  disableWake() {
    this.wakeEnabled = false;
    this.lastHeard = "";
    this.generation += 1;
    this.cancelRecording();
    this.stopWake();
    this.closeAudioContext();
    this.onChange();
  }

  supportError() {
    return !globalThis.isSecureContext
      ? "浏览器只允许在 HTTPS 或 localhost 页面使用麦克风；手机访问请使用 HTTPS。"
      : "当前浏览器不支持网页录音或声音检测，请更新浏览器后重试。";
  }

  async prepareAudioContext() {
    if (!this.audioContext || this.audioContext.state === "closed") this.audioContext = new this.AudioContext();
    const context = this.audioContext;
    if (context.state !== "running") {
      let timeout;
      try {
        await Promise.race([
          context.resume(),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("请再点一次麦克风，允许浏览器启动声音检测。")), 3000); })
        ]);
      } finally { clearTimeout(timeout); }
    }
    return context;
  }

  closeAudioContext() {
    const context = this.audioContext;
    this.audioContext = null;
    if (context && context.state !== "closed") context.close().catch(() => {});
  }

  shouldListen() {
    return this.wakeEnabled && !this.blocked && !this.hidden && !this.capturing;
  }

  reconcileWake() {
    if (this.shouldListen()) {
      if (!this.recognition && !this.wakeTimer && !this.wakeStopping) this.startWake();
    } else {
      this.stopWake();
    }
    this.onChange();
  }

  stopWake() {
    clearTimeout(this.wakeTimer);
    clearTimeout(this.wakeStartTimer);
    this.wakeTimer = null;
    if (this.wakeStopping) return this.wakeStopping;
    const recognition = this.recognition;
    this.recognition = null;
    if (this.phase === "listening") this.phase = "idle";
    if (!recognition) return Promise.resolve();
    // Wait for the browser to release its microphone before MediaRecorder starts.
    this.wakeStopping = new Promise((resolve) => {
      const timeout = setTimeout(resolve, 1200);
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onstart = null;
      recognition.onend = () => { clearTimeout(timeout); resolve(); };
      try { recognition.abort(); } catch (_) { clearTimeout(timeout); resolve(); }
    }).then(() => {
      this.wakeStopping = null;
      // A blocker may have been removed while abort() was completing.
      if (this.shouldListen()) this.reconcileWake();
    });
    return this.wakeStopping;
  }

  startWake() {
    if (!this.shouldListen()) return;
    let recognition;
    try {
      recognition = new this.Recognition();
      this.recognition = recognition;
      recognition.lang = "zh-CN";
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 3;
      const startedAt = performance.now();
      recognition.onstart = () => {
        if (this.recognition !== recognition) return;
        clearTimeout(this.wakeStartTimer);
        this.phase = "listening";
        this.onChange();
      };
      recognition.onresult = (event) => {
        if (this.recognition !== recognition || !this.shouldListen()) return;
        // Reassemble adjacent results too, in case the engine splits “你好 / 迦童”.
        const recent = Array.from(event.results).slice(-3);
        const primary = recent.map((result) => result[0]?.transcript || "").join("");
        this.lastHeard = primary.slice(-100);
        const matched = matchesWakePhrase(primary, this.wakePhrase) || recent.some((result) => Array.from(result).some((alt) => matchesWakePhrase(alt.transcript, this.wakePhrase)));
        if (matched) {
          this.wakeFailures = 0;
          this.handleWake();
        }
        this.onChange();
      };
      recognition.onerror = (event) => {
        if (this.recognition !== recognition || ["no-speech", "aborted"].includes(event.error)) return;
        const errors = {
          "not-allowed": "语音唤醒权限被拒绝，请在浏览器设置中允许麦克风和语音识别后重试。",
          "service-not-allowed": "浏览器的语音识别服务不可用，请使用麦克风按钮录音。",
          "audio-capture": "无法使用麦克风，请检查设备连接和麦克风权限。",
          "network": "浏览器唤醒识别连接失败，请检查网络，或使用麦克风按钮录音。",
          "language-not-supported": "浏览器语音识别不支持中文，请使用麦克风按钮录音。"
        };
        this.failWake(errors[event.error] || "语音唤醒暂时不可用，请重新开启或使用麦克风按钮录音。");
      };
      recognition.onend = () => {
        if (this.recognition !== recognition) return;
        clearTimeout(this.wakeStartTimer);
        this.recognition = null;
        this.phase = "idle";
        this.wakeFailures = performance.now() - startedAt < 2000 ? this.wakeFailures + 1 : 0;
        if (this.wakeFailures >= 4) {
          this.failWake("浏览器反复中断唤醒监听，请重新开启，或使用麦克风按钮录音。");
          return;
        }
        if (this.shouldListen()) {
          this.wakeTimer = setTimeout(() => {
            this.wakeTimer = null;
            this.reconcileWake();
          }, 400);
        }
        this.onChange();
      };
      this.wakeStartTimer = setTimeout(() => {
        if (this.recognition === recognition) this.failWake("唤醒识别启动超时，请检查浏览器权限和网络，或使用麦克风按钮录音。");
      }, 10_000);
      recognition.start();
    } catch (_) {
      this.failWake("浏览器无法启动语音唤醒，请重新开启，或使用麦克风按钮录音。");
    }
  }

  failWake(message) {
    this.disableWake();
    this.onError(message);
  }

  async handleWake() {
    if (!this.shouldListen()) return;
    const generation = ++this.generation;
    const abort = new AbortController();
    this.greetingAbort = abort;
    this.phase = "greeting";
    this.onChange();
    try {
      await this.stopWake();
      if (abort.signal.aborted) return;
      const audioContext = await this.prepareAudioContext();
      if (abort.signal.aborted) return;
      // Finish the acknowledgement before opening the formal recording stream.
      await this.onWake({ signal: abort.signal, audioContext });
    } catch (_) {
      if (!abort.signal.aborted) this.onNotice("已唤醒，但应答语音播放失败；请看到录音提示后讲话。");
    } finally {
      if (this.greetingAbort === abort) this.greetingAbort = null;
      if (generation === this.generation) {
        this.phase = "idle";
        if (!abort.signal.aborted && this.wakeEnabled && !this.hidden && !this.blocked) await this.startRecording();
        else this.reconcileWake();
      }
    }
  }

  async startRecording() {
    if (this.capturing || this.blocked || this.hidden) return;
    if (!this.supported) { this.onError(this.supportError()); return; }
    const generation = ++this.generation;
    this.phase = "starting";
    this.onChange();
    let stream;
    try {
      // Resume immediately on manual clicks, before yielding the gesture.
      const contextPromise = this.prepareAudioContext();
      await this.stopWake();
      const context = await contextPromise;
      if (generation !== this.generation) return;
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      if (generation !== this.generation || this.hidden || this.blocked) {
        stream.getTracks().forEach((track) => track.stop());
        if (generation === this.generation) this.phase = "idle";
        return;
      }
      const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"]
        .find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const source = context.createMediaStreamSource(stream);
      const filter = context.createBiquadFilter();
      filter.type = "highpass";
      filter.frequency.value = 100;
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(filter);
      filter.connect(analyser);
      const vad = new VoiceActivityDetector({ silenceMs: this.silenceMs });
      const session = { recorder, stream, source, filter, analyser, vad, chunks: [], submit: true, interval: null, limit: null };
      this.session = session;
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data?.size) session.chunks.push(event.data);
      });
      recorder.addEventListener("stop", () => this.finishSession(session), { once: true });
      recorder.addEventListener("error", () => {
        if (this.session !== session) return;
        this.failWake("录音意外中断，请检查麦克风后重试。");
      }, { once: true });
      stream.getAudioTracks().forEach((track) => track.addEventListener("ended", () => {
        if (this.session !== session) return;
        this.failWake("麦克风已断开，录音已取消。");
      }, { once: true }));
      recorder.start();
      this.phase = "recording";
      const samples = new Float32Array(analyser.fftSize);
      const sample = () => {
        if (this.session !== session || this.phase !== "recording") return;
        if (context.state !== "running") {
          this.failWake("浏览器暂停了声音检测，请保持页面在前台后重试。");
          return;
        }
        analyser.getFloatTimeDomainData(samples);
        const reason = vad.process(samples, performance.now());
        if (reason) this.stopRecording(reason);
      };
      sample();
      if (this.session !== session) return;
      session.interval = setInterval(sample, 50);
      session.limit = setTimeout(() => this.stopRecording("limit"), MAX_RECORDING_MS);
      this.onChange();
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      if (generation !== this.generation) return;
      if (this.session) this.releaseSession(this.session);
      this.session = null;
      this.phase = "idle";
      // Prevent an endless wake -> permission error -> wake cycle.
      this.wakeEnabled = false;
      this.closeAudioContext();
      this.onError(error.name === "NotAllowedError"
        ? "麦克风权限未开启，请在浏览器设置中允许访问麦克风。"
        : error.name === "NotFoundError" ? "没有找到麦克风，请连接麦克风后重试。"
          : "无法启动录音，请检查设备和浏览器权限。");
    } finally {
      this.reconcileWake();
    }
  }

  stopRecording(reason = "manual") {
    const session = this.session;
    if (!session || this.phase !== "recording") return;
    session.submit = reason !== "no-speech" && session.vad.hasSpeech;
    this.phase = "stopping";
    clearInterval(session.interval);
    clearTimeout(session.limit);
    if (reason === "limit" && session.submit) this.onNotice("录音已达到 2 分钟上限，正在识别。");
    if (!session.submit) this.onNotice("没有检测到讲话，已取消这次录音。");
    session.recorder.stop();
    this.onChange();
  }

  cancelRecording() {
    this.generation += 1;
    this.greetingAbort?.abort();
    this.greetingAbort = null;
    const session = this.session;
    this.session = null;
    this.phase = "idle";
    if (session) {
      session.submit = false;
      this.releaseSession(session);
      if (session.recorder.state !== "inactive") session.recorder.stop();
    }
    if (!this.wakeEnabled) this.closeAudioContext();
    this.onChange();
  }

  releaseSession(session) {
    clearInterval(session.interval);
    clearTimeout(session.limit);
    session.source.disconnect();
    session.filter.disconnect();
    session.analyser.disconnect();
    session.stream.getTracks().forEach((track) => track.stop());
  }

  finishSession(session) {
    if (this.session !== session) return;
    this.session = null;
    this.phase = "idle";
    this.releaseSession(session);
    if (!this.wakeEnabled) this.closeAudioContext();
    const blob = new Blob(session.chunks, { type: session.recorder.mimeType || "application/octet-stream" });
    session.chunks = [];
    // onRecording synchronously blocks wake listening while transcription runs.
    if (session.submit && session.vad.hasSpeech && blob.size) this.onRecording(blob);
    else if (session.submit) this.onError("没有录到有效讲话，请重新录制。");
    this.reconcileWake();
  }

  destroy() { this.disableWake(); }
}
