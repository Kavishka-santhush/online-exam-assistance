import { SignUp } from '@clerk/clerk-react';

/**
 * Sign-up screen — mirrors `SignInPage`: a thin view around Clerk's `<SignUp/>`,
 * relying on `AuthLayout` for the centered brand card, theme and Toaster.
 *
 * After Clerk creates the account, the first `/auth/me` call lazily provisions
 * the local `User` row server-side, so there is nothing extra to do here beyond
 * sending the new user to the dashboard.
 */
export default function SignUpPage() {
  return (
    <SignUp
      routing="path"
      path="/sign-up"
      signInUrl="/sign-in"
      fallbackRedirectUrl="/dashboard"
    />
  );
}
