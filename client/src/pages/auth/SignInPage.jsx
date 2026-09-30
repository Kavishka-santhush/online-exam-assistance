import { SignIn } from '@clerk/clerk-react';

/**
 * Sign-in screen — a thin view around Clerk's `<SignIn/>`.
 *
 * `AuthLayout` (see route nesting in App.jsx) already supplies the centered
 * brand card, the theme class and the Toaster, so this page renders nothing but
 * the Clerk widget itself. Clerk owns the whole flow (password, OAuth, MFA); we
 * just point it at the sibling sign-up route and a sensible post-auth home.
 * `fallbackRedirectUrl` is used unless Clerk was bounced here from a protected
 * route, in which case its `redirect_url` query param takes precedence.
 */
export default function SignInPage() {
  return (
    <SignIn
      routing="path"
      path="/sign-in"
      signUpUrl="/sign-up"
      fallbackRedirectUrl="/dashboard"
    />
  );
}
