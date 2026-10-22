import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { PageHead } from '../components/Shell';
import { canListen, listen, speak, stopSpeaking } from '../lib/speech';

interface Msg {
  role: 'u' | 'a';
  text: string;
  tool?: string;
}

const SUGGESTIONS = [
  "How did today's interviews go?",
  'Compare the top two',
  'How did Rahul do?',
  'Move Rahul to the next round',
  'What jobs are open?',
  'Share the backend invite link',
];

export function AlexaSimulator() {
  const [msgs, setMsgs] = useState<Msg[]>([{ role: 'a', text: "Hi, I'm Alexa with Intervwd. Ask me how hiring is going." }]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [voice, setVoice] = useState(true);
  const [err, setErr] = useState<string>();
  const listener = useRef<{ stop(): void }>();
  const heard = useRef('');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight, behavior: 'smooth' });
  }, [msgs]);
  useEffect(() => () => {
    listener.current?.stop();
    stopSpeaking();
  }, []);

  const ask = async (message: string) => {
    const m = message.trim();
    if (!m) return setErr('Say or type a request first.');
    setErr(undefined);
    setText('');
    setMsgs((x) => [...x, { role: 'u', text: m }]);
    setBusy(true);
    try {
      const reply = await api.assistant(m);
      setMsgs((x) => [...x, { role: 'a', text: reply.text, tool: reply.tool }]);
      if (voice) await speak(reply.text);
    } catch (e) {
      setMsgs((x) => [...x, { role: 'a', text: (e as Error).message }]);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    ask(text);
  };

  const talk = () => {
    if (listening) {
      listener.current?.stop();
      setListening(false);
      ask(heard.current);
      return;
    }
    stopSpeaking();
    heard.current = '';
    setListening(true);
    listener.current = listen((t) => {
      heard.current = t;
      setText(t);
    }, (m) => {
      setErr(m);
      setListening(false);
    });
  };

  return (
    <>
      <PageHead title="Alexa+" sub="Run your hiring pipeline hands-free. On a real Echo, Alexa+ calls the same Intervwd MCP tools shown under each reply." />
      <div className="split-wide">
        <div className="echo" aria-label="Echo Show simulator">
          <div className="msgs" ref={box} aria-live="polite">
            {msgs.map((m, i) => (
              <div key={i} style={{ display: 'contents' }}>
                <div className={m.role}>{m.text}</div>
                {m.tool && <div className="tool">↳ {m.tool}</div>}
              </div>
            ))}
            {busy && <div className="a" style={{ opacity: 0.7 }}>…</div>}
          </div>
          <div className={`ring ${listening || busy ? 'on' : ''}`}><i /></div>
          <form className="row" onSubmit={submit}>
            {canListen && (
              <button type="button" className="btn" onClick={talk} aria-label={listening ? 'Stop and send' : 'Talk to Alexa'} style={{ background: listening ? '#1fb5ff' : '#262b42', borderColor: 'transparent', color: '#fff' }}>
                <Icon name={listening ? 'send' : 'mic'} />
              </button>
            )}
            <input value={text} onChange={(e) => { setText(e.target.value); setErr(undefined); }} placeholder={listening ? 'Listening…' : 'Alexa, how did today\'s interviews go?'} aria-label="Message to Alexa" />
            <button className="btn btn-primary" disabled={busy}>Send</button>
          </form>
          {err && <p className="error">{err}</p>}
        </div>

        <div className="stack">
          <div className="card">
            <h3 style={{ marginBottom: 10 }}>Try saying</h3>
            <div className="stack" style={{ gap: 8 }}>
              {SUGGESTIONS.map((s) => <button key={s} className="chip" onClick={() => ask(s)} disabled={busy}>"{s}"</button>)}
            </div>
            <label className="row small" style={{ marginTop: 14, cursor: 'pointer' }}>
              <input type="checkbox" checked={voice} onChange={(e) => { setVoice(e.target.checked); if (!e.target.checked) stopSpeaking(); }} style={{ marginTop: 0 }} />
              <span className="muted">Speak replies out loud</span>
            </label>
          </div>
          <div className="card">
            <h3 style={{ marginBottom: 6 }}>Connect your Echo</h3>
            <p className="small muted">Add Intervwd to Alexa+ with this MCP server address, then sign in with your work email.</p>
            <input readOnly value={`${location.origin}/mcp`} style={{ marginTop: 10 }} className="small" onFocus={(e) => e.target.select()} />
            <p className="faint" style={{ marginTop: 8 }}>Changes like moving a candidate on always need your "yes" first.</p>
          </div>
        </div>
      </div>
    </>
  );
}
