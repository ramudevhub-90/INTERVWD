// Voice in and out for the interview room, using the browser's speech APIs.
// The interviewer speaks with speechSynthesis; the candidate's answer is captioned live with
// SpeechRecognition (Chrome, Edge, Safari). Where recognition isn't available, candidates type.

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

const Ctor = (window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }).SpeechRecognition
  ?? (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition;

export const canListen = !!Ctor;
export const canSpeak = 'speechSynthesis' in window;

function voice(): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices();
  const en = voices.filter((v) => v.lang.startsWith('en'));
  return en.find((v) => /Google UK English Female|Samantha|Microsoft (Aria|Jenny|Neerja)/i.test(v.name)) ?? en.find((v) => v.lang === 'en-IN') ?? en[0];
}

export function speak(text: string): Promise<void> {
  if (!canSpeak) return Promise.resolve();
  speechSynthesis.cancel();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    const v = voice();
    if (v) u.voice = v;
    u.rate = 1;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    speechSynthesis.speak(u);
    // Some browsers never fire onend for long text; don't leave the candidate waiting.
    setTimeout(resolve, Math.max(4000, text.length * 85));
  });
}

export function stopSpeaking() {
  if (canSpeak) speechSynthesis.cancel();
}

/** Listens until stop() is called; onText gets the whole answer so far (final + interim). */
export function listen(onText: (text: string) => void, onError: (message: string) => void) {
  if (!Ctor) {
    onError('Voice captions need Chrome, Edge or Safari. You can type your answer instead.');
    return { stop() {} };
  }
  let finalText = '';
  let stopped = false;
  const rec = new Ctor();
  rec.lang = navigator.language.startsWith('en') ? navigator.language : 'en-IN';
  rec.continuous = true;
  rec.interimResults = true;
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript.trim() + ' ';
      else interim += r[0].transcript;
    }
    onText((finalText + interim).trim());
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed') onError('Microphone access is blocked. Allow it in the address bar, or type your answer.');
  };
  // Recognition stops itself after silence; keep it going until the candidate finishes.
  rec.onend = () => {
    if (!stopped) {
      try {
        rec.start();
      } catch {
        /* already restarting */
      }
    }
  };
  rec.start();
  return {
    stop() {
      stopped = true;
      rec.stop();
    },
  };
}
