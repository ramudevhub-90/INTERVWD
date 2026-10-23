import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './styles.css';
import { AuthProvider } from './lib/util';
import { Shell } from './components/Shell';
import { Landing } from './pages/Landing';
import { SignIn, SignUp } from './pages/Auth';
import { Dashboard } from './pages/Dashboard';
import { Jobs, NewJob } from './pages/Jobs';
import { JobDetail } from './pages/JobDetail';
import { NewRound } from './pages/NewRound';
import { CandidateReport } from './pages/CandidateReport';
import { AlexaSimulator } from './pages/Alexa';
import { Settings } from './pages/Settings';

// The video call pages bring in the Chime SDK, so they load only when someone opens a call.
const CandidateCall = lazy(() => import('./pages/CallPage').then((m) => ({ default: m.CandidateCall })));
const HostCall = lazy(() => import('./pages/CallPage').then((m) => ({ default: m.HostCall })));
const later = (el: JSX.Element) => <Suspense fallback={<div className="empty faint">Loading the call…</div>}>{el}</Suspense>;
import { Invite } from './pages/Invite';
import { InterviewRoom } from './pages/InterviewRoom';
import { Connect } from './pages/Connect';
import { EchoInterview } from './pages/EchoInterview';
import { ReceptionKiosk, RoomKiosk } from './pages/Kiosk';
import { Practice } from './pages/Practice';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/signin" element={<SignIn />} />
          <Route path="/signup" element={<SignUp />} />
          <Route path="/i/:code" element={<Invite />} />
          <Route path="/interview/:id" element={<InterviewRoom />} />
          <Route path="/connect" element={<Connect />} />
          <Route path="/echo/:id" element={<EchoInterview />} />
          <Route path="/practice/:id" element={<Practice />} />
          <Route path="/kiosk/:token" element={<ReceptionKiosk />} />
          <Route path="/kiosk/:token/room/:room" element={<RoomKiosk />} />
          <Route path="/call/:id" element={later(<CandidateCall />)} />
          <Route path="/app" element={<Shell />}>
            <Route index element={<Dashboard />} />
            <Route path="jobs" element={<Jobs />} />
            <Route path="jobs/new" element={<NewJob />} />
            <Route path="jobs/:jobId" element={<JobDetail />} />
            <Route path="jobs/:jobId/rounds/new" element={<NewRound />} />
            <Route path="candidates/:candidateId" element={<CandidateReport />} />
            <Route path="alexa" element={<AlexaSimulator />} />
            <Route path="settings" element={<Settings />} />
            <Route path="call/:id" element={later(<HostCall />)} />
          </Route>
          <Route path="/:org/:round" element={<Invite />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
