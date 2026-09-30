import { Outlet, Link } from 'react-router-dom';
import { useTheme } from '@/hooks/useTheme';
import { Toaster } from '@/components/common/Toaster';

/**
 * Light-weight centered layout for the auth pages. It is intentionally NOT the
 * app shell — no sidebar/topbar — but it does apply the theme and mount the
 * Toaster so validation/notice toasts still show on sign-in. Each page renders
 * its own Clerk `<SignIn/>` / `<SignUp/>` inside the card in `children`
 * (via `<Outlet/>`).
 */
export default function AuthLayout() {
  useTheme();

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-muted/30 px-4 py-10">
      <Link to="/" className="mb-8 flex items-center gap-2 font-semibold">
        <span className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground text-base font-bold">E</span>
        <span className="text-lg">ExamFlow</span>
      </Link>
      <div className="w-full max-w-md">
        <Outlet />
      </div>
      <p className="mt-8 text-center text-xs text-muted-foreground">
        Secured authentication handled by Clerk.
      </p>
      <Toaster />
    </div>
  );
}
