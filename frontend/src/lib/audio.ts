let audioCtx: AudioContext | null = null;

export function getAudioCtx(): AudioContext {
  if (!audioCtx) {
    const AudioContextCtor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    audioCtx = new AudioContextCtor();
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

// Percussive mechanical "tic" - filtered noise burst with a near-instant
// attack and fast decay, not a pitched tone. Real clicks are broadband
// noise, not a "bip" with a pitch bend.
let tickNoiseBuffer: AudioBuffer | null = null;

export function playTick(): void {
  const ac = getAudioCtx();
  if (!tickNoiseBuffer) {
    const len = Math.ceil(ac.sampleRate * 0.03);
    tickNoiseBuffer = ac.createBuffer(1, len, ac.sampleRate);
    const data = tickNoiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }
  const now = ac.currentTime;
  const noise = ac.createBufferSource();
  noise.buffer = tickNoiseBuffer;

  const bandpass = ac.createBiquadFilter();
  bandpass.type = "bandpass";
  bandpass.frequency.value = 2000 + Math.random() * 900;
  bandpass.Q.value = 1.0;

  const gain = ac.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.85, now + 0.0015);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.026);

  noise.connect(bandpass).connect(gain).connect(ac.destination);
  noise.start(now);
  noise.stop(now + 0.03);
}

export function playWinChime(): void {
  const ac = getAudioCtx();
  const now = ac.currentTime;
  [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
    const t0 = now + i * 0.1;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.16, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.55);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + 0.6);
  });
}
