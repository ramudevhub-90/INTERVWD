import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

// The candidate's side of a live AI interview: their camera and microphone join the interview's
// Chime call, so someone from the team can watch, and step in. The screen always shows who's
// watching. While a person has taken over, the AI waits; when they hand back, the AI carries on.

export interface LiveState {
  watchers: string[];
  takenOverBy: string | null;
  /** Bumped each time a person hands back to the AI, so the room can carry on. */
  resumed: number;
}

export function useLive(interviewId: string, active: boolean): LiveState {
  const [state, setState] = useState<LiveState>({ watchers: [], takenOverBy: null, resumed: 0 });
  const audio = useRef<HTMLAudioElement>();
  const previous = useRef<string | null>(null);

  // Join the call once the interview is running. The Chime SDK loads only now.
  useEffect(() => {
    if (!active || api.mode !== 'http') return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const seat = await api.joinLive(interviewId);
        const chime = await import('amazon-chime-sdk-js');
        if (cancelled) return;
        const logger = new chime.ConsoleLogger('intervwd-live', chime.LogLevel.ERROR);
        const session = new chime.DefaultMeetingSession(new chime.MeetingSessionConfiguration(seat.meeting, seat.attendee), logger, new chime.DefaultDeviceController(logger));
        const av = session.audioVideo;
        const mics = await av.listAudioInputDevices();
        if (mics[0]) await av.startAudioInput(mics[0].deviceId);
        const cams = await av.listVideoInputDevices();
        if (cams[0]) await av.startVideoInput(cams[0].deviceId);
        audio.current = audio.current ?? Object.assign(document.createElement('audio'), { autoplay: true });
        await av.bindAudioElement(audio.current);
        av.start();
        if (cams[0]) av.startLocalVideoTile();
        stop = () => {
          av.stopLocalVideoTile();
          av.stop();
          av.stopVideoInput().catch(() => undefined);
          av.stopAudioInput().catch(() => undefined);
        };
      } catch {
        /* live watching is optional; the interview carries on without it */
      }
    })();
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [interviewId, active]);

  // Who's watching, and whether someone has taken over.
  useEffect(() => {
    if (!active || api.mode !== 'http') return;
    let live = true;
    const poll = () => api.liveStatus(interviewId).then((s) => {
      if (!live) return;
      const handedBack = previous.current && !s.takenOverBy;
      previous.current = s.takenOverBy;
      setState((st) => ({ watchers: s.watchers, takenOverBy: s.takenOverBy, resumed: handedBack ? st.resumed + 1 : st.resumed }));
    }).catch(() => undefined);
    poll();
    const t = setInterval(poll, 3000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [interviewId, active]);

  return state;
}
