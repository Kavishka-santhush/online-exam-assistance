import { Suspense, lazy, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { SignedIn, SignedOut, useAuth, useClerk } from '@clerk/clerk-react';

import { useAppDispatch, useAppSelector } from '@/hooks/useRedux';
import { fetchMe, selectIsHydrated, signOutCleared } from '@/store/slices/authSlice';
import { connectSocket, disconnectSocket } from '@/lib/socket';

// Lazy page/component imports — split per feature so the auth-only landing view
// stays light and each screen loads on navigation.
const AppLayout = lazy(() => import('@/components/layout/AppLayout'));
const AuthLayout = lazy(() => import('@/components/layout/AuthLayout'));
const RouteFallback = lazy(() => import('@/components/common/RouteFallback'));

const LandingPage = lazy(() => import('@/pages/LandingPage'));
const PricingPage = lazy(() => import('@/pages/PricingPage'));
const VerifyCertificatePage = lazy(() => import('@/pages/VerifyCertificatePage'));
const JoinExamPage = lazy(() => import('@/pages/JoinExamPage'));
const SignInPage = lazy(() => import('@/pages/auth/SignInPage'));
const SignUpPage = lazy(() => import('@/pages/auth/SignUpPage'));

const DashboardPage = lazy(() => import('@/pages/DashboardPage'));
const ExamsPage = lazy(() => import('@/pages/ExamsPage'));
const ExamBuilderPage = lazy(() => import('@/pages/exam-builder/ExamBuilderPage'));
const ExamDetailPage = lazy(() => import('@/pages/ExamDetailPage'));
const QuestionBanksPage = lazy(() => import('@/pages/QuestionBanksPage'));
const QuestionBankDetailPage = lazy(() => import('@/pages/QuestionBankDetailPage'));
const TakeExamPage = lazy(() => import('@/pages/exam-taking/TakeExamPage'));
const ExamResultPage = lazy(() => import('@/pages/ExamResultPage'));
const LiveQuizHostPage = lazy(() => import('@/pages/LiveQuizHostPage'));
const LiveQuizJoinPage = lazy(() => import('@/pages/LiveQuizJoinPage'));

const ProctorDashboardPage = lazy(() => import('@/pages/proctoring/ProctorDashboardPage'));
const GradingQueuePage = lazy(() => import('@/pages/grading/GradingQueuePage'));
const GradingDetailPage = lazy(() => import('@/pages/grading/GradingDetailPage'));
const AnalyticsPage = lazy(() => import('@/pages/AnalyticsPage'));
const CertificatesPage = lazy(() => import('@/pages/CertificatesPage'));
const NotificationsPage = lazy(() => import('@/pages/NotificationsPage'));
const OrganizationSettingsPage = lazy(() => import('@/pages/OrganizationSettingsPage'));
const ProfilePage = lazy(() => import('@/pages/ProfilePage'));
const BillingPage = lazy(() => import('@/pages/BillingPage'));
const AdminPage = lazy(() => import('@/pages/admin/AdminPage'));
const NotFoundPage = lazy(() => import('@/pages/NotFoundPage'));

/**
 * Root route table.
 *
 * Auth model: Clerk owns the session, so `SignedOut` users only ever reach the
 * public marketing + access pages and Clerk's own sign-in/up. Everything behind
 * `<SignedIn>` renders through `AppLayout`, whose `SessionBootstrap` effect (see
 * below) pulls the local `User` row and opens the socket. The exam-taking route
 * is intentionally a *sibling* of `AppLayout` (full-bleed, no chrome) so a
 * proctored candidate is never able to navigate away via the shell's sidebar.
 */
export default function App() {
  const dispatch = useAppDispatch();
  const { isLoaded, isSignedIn } = useAuth();
  const hydrated = useAppSelector(selectIsHydrated);
  const clerk = useClerk();
  const location = useLocation();

  // Mirror Clerk's session into Redux and keep the realtime socket in step with
  // it. We fetch `/auth/me` once per sign-in (not per navigation) and tear the
  // socket + local mirror down on sign-out.
  useEffect(() => {
    if (isLoaded && isSignedIn && !hydrated) dispatch(fetchMe());
  }, [isLoaded, isSignedIn, hydrated, dispatch]);

  useEffect(() => {
    if (isSignedIn) connectSocket();
    else {
      disconnectSocket();
      dispatch(signOutCleared());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSignedIn, clerk]);

  if (!isLoaded) {
    // Clerk is still bootstrapping — a plain inline spinner (not the lazy
    // RouteFallback, which needs the Suspense boundary defined below).
    return <div className="flex min-h-screen items-center justify-center text-muted-foreground">Loading…</div>;
  }

  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        {/* ---- public ---- */}
        <Route path="/" element={<LandingPage />} />
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/verify/:code?" element={<VerifyCertificatePage />} />
        {/* candidate joins a shared/invite exam without necessarily having an account */}
        <Route path="/join/:accessKey" element={<JoinExamPage />} />

        {/* ---- auth (thin wrappers around Clerk's components) ---- */}
        <Route element={<AuthLayout />}>
          <Route path="/sign-in" element={<SignedOut><SignInPage /></SignedOut>} />
          <Route path="/sign-up" element={<SignedOut><SignUpPage /></SignedOut>} />
        </Route>

        {/* ---- candidate: full-bleed exam runtime, outside the app shell ---- */}
        <SignedIn>
          <Route path="/exam/:examId/take" element={<TakeExamPage />} />
          <Route path="/live/:code" element={<LiveQuizJoinPage />} />
        </SignedIn>

        {/* ---- everything else inside the authenticated chrome ---- */}
        <SignedIn>
          <Route element={<AppLayout />}>
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/exams" element={<ExamsPage />} />
            <Route path="/exams/new" element={<ExamBuilderPage />} />
            <Route path="/exams/:examId" element={<ExamDetailPage />} />
            <Route path="/exams/:examId/edit" element={<ExamBuilderPage />} />
            <Route path="/exams/:examId/results/:attemptId" element={<ExamResultPage />} />
            <Route path="/exams/:examId/proctor" element={<ProctorDashboardPage />} />
            <Route path="/exams/:examId/live" element={<LiveQuizHostPage />} />

            <Route path="/question-banks" element={<QuestionBanksPage />} />
            <Route path="/question-banks/:bankId" element={<QuestionBankDetailPage />} />

            <Route path="/grading" element={<GradingQueuePage />} />
            <Route path="/grading/:answerId" element={<GradingDetailPage />} />

            <Route path="/analytics" element={<AnalyticsPage />} />
            <Route path="/analytics/:examId" element={<AnalyticsPage />} />
            <Route path="/certificates" element={<CertificatesPage />} />
            <Route path="/notifications" element={<NotificationsPage />} />
            <Route path="/billing" element={<BillingPage />} />
            <Route path="/organization" element={<OrganizationSettingsPage />} />
            <Route path="/profile" element={<ProfilePage />} />

            <Route path="/admin/*" element={<AdminPage />} />

            <Route path="*" element={<RedirectOrNotFound location={location} />} />
          </Route>
        </SignedIn>
      </Routes>
    </Suspense>
  );
}

/** A signed-out visitor hitting a protected path is bounced to sign-in; a
 *  signed-in unknown path renders the 404 inside the shell. */
function RedirectOrNotFound({ location }) {
  const { isSignedIn } = useAuth();
  if (!isSignedIn) return <Navigate to="/sign-in" state={{ from: location?.pathname }} replace />;
  return <NotFoundPage />;
}
