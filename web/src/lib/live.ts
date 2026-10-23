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

/** `stream` is the camera and mic the page already has open: the call reuses it, because iPhones
 * only let a page capture the camera once at a time (a second capture fails or freezes the first). */
export function useLive(interviewId: string, active: boolean, teamVideo?: React.RefObject<HTMLVideoElement>, stream?: MediaStream): LiveState & { teamOnCamera: boolean } {
  const [state, setState] = useState<LiveState>({ watchers: [], takenOverBy: null, resumed: 0 });
  const [teamOnCamera, setTeamOnCamera] = useState(false);
  const audio = useRef<HTMLAudioElement>();
  const previous = useRef<string | null>(null);

  // Join the call once the interview is running. The Chime SDK loads only now.
  useEffect(() => {
    if (!active || api.mode !== 'http') return;
    let stop: (() => void) | undefined;
    const own = stream?.getVideoTracks().some((t) => t.readyState === 'live') ? stream : undefined;
    let cancelled = false;
    (async () => {
      try {
        const seat = await api.joinLive(interviewId);
        const chime = await import('amazon-chime-sdk-js');
        if (cancelled) return;
        const logger = new chime.ConsoleLogger('intervwd-live', chime.LogLevel.ERROR);
        const session = new chime.DefaultMeetingSession(new chime.MeetingSessionConfiguration(seat.meeting, seat.attendee), logger, new chime.DefaultDeviceController(logger));
        const av = session.audioVideo;
        // Each device on its own: a busy camera still lets the team hear the candidate, and the reverse.
        let camOn = false;
        try {
          if (own?.getAudioTracks().length) await av.startAudioInput(new MediaStream(own.getAudioTracks()));
          else {
            const mics = await av.listAudioInputDevices();
            if (mics[0]) await av.startAudioInput(mics[0].deviceId);
          }
        } catch { /* no microphone */ }
        try {
          if (own) { await av.startVideoInput(new MediaStream(own.getVideoTracks())); camOn = true; }
          else {
            const cams = await av.listVideoInputDevices();
            if (cams[0]) { await av.startVideoInput(cams[0].deviceId); camOn = true; }
          }
        } catch { /* no camera */ }
        // The team member's voice: an <audio> element in the page (some browsers won't play a detached one).
        if (!audio.current) {
          audio.current = Object.assign(document.createElement('audio'), { autoplay: true });
          audio.current.setAttribute('aria-hidden', 'true');
          document.body.appendChild(audio.current);
        }
        await av.bindAudioElement(audio.current);
        audio.current.play().catch(() => undefined);
        // The team member's camera (when they take over): shown on the candidate's screen.
        av.addObserver({
          videoTileDidUpdate: (tile) => {
            if (tile.localTile || !tile.boundAttendeeId || tile.tileId == null || tile.isContent) return;
            const el = teamVideo?.current;
            if (el) {
              el.muted = true; // the voice comes through the audio element; muted video may autoplay on iPhones
              av.bindVideoElement(tile.tileId, el);
              el.play().catch(() => undefined);
            }
            setTeamOnCamera(true);
          },
          videoTileWasRemoved: () => setTeamOnCamera(false),
        });
        av.start();
        if (camOn) av.startLocalVideoTile();
        stop = () => {
          audio.current?.remove();
          audio.current = undefined;
          av.stopLocalVideoTile();
          av.stop();
          // Leave the page's own camera running: only stop what the call opened itself.
          if (!own) {
            av.stopVideoInput().catch(() => undefined);
            av.stopAudioInput().catch(() => undefined);
          }
        };
      } catch {
        /* live watching is optional; the interview carries on without it */
      }
    })();
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [interviewId, active, !!stream]); // eslint-disable-line react-hooks/exhaustive-deps

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

  return { ...state, teamOnCamera };
}
