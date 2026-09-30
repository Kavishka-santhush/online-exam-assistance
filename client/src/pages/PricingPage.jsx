import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { SignedIn, SignedOut } from '@clerk/clerk-react';
import { Check, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { request, endpoints } from '@/lib/apiClient';

/**
 * Public pricing page.
 *
 * We ship a static tier layout so the page renders instantly for anonymous
 * visitors (no session, so `/payments/plans` would 401), then opportunistically
 * enrich it with whatever the server publishes under `/payments/plans` when the
 * call succeeds. A billing toggle is pure presentation — it just swaps which
 * price string we show — because checkout itself happens through Stripe on the
 * server, not here.
 */
const DEFAULT_PLANS = [
  {
    code: 'free',
    name: 'Starter',
    priceMonthly: 0,
    priceAnnual: 0,
    tagline: 'For individuals trying the platform out.',
    features: ['Up to 3 active exams', '25 candidates per exam', 'All core question types', 'Public certificate verification'],
    cta: 'Start free',
  },
  {
    code: 'pro',
    name: 'Professional',
    priceMonthly: 39,
    priceAnnual: 390,
    tagline: 'For instructors and small institutions.',
    highlight: true,
    features: ['Unlimited exams', '250 candidates per exam', 'Live AI proctoring', 'Question banks & import/export', 'Analytics & item analysis', 'Priority support'],
    cta: 'Upgrade to Pro',
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    priceMonthly: null,
    priceAnnual: null,
    tagline: 'For universities and certification bodies.',
    features: ['Unlimited everything', 'SSO & custom branding', 'On-prem / self-hosted uploads', 'Dedicated proctoring team', 'SLA & audit exports'],
    cta: 'Contact sales',
  },
];

function formatPrice(value, annual) {
  if (value == null) return 'Custom';
  if (value === 0) return '$0';
  const amount = annual ? value : value;
  return `$${amount.toLocaleString()}`;
}

export default function PricingPage() {
  const [annual, setAnnual] = useState(true);
  const [plans, setPlans] = useState(DEFAULT_PLANS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    // Best-effort: if the server publishes plan data, merge it over the static
    // tiers. Any error (offline, 401, 404) silently keeps the defaults.
    request
      .get(endpoints.payments.plans)
      .then((data) => {
        if (!alive) return;
        const list = Array.isArray(data) ? data : data?.plans ?? data?.items;
        if (Array.isArray(list) && list.length) {
          setPlans(list.map((p) => ({
            code: p.code ?? p.id,
            name: p.name ?? p.title,
            priceMonthly: p.priceMonthly ?? p.monthly ?? 0,
            priceAnnual: p.priceAnnual ?? p.annual ?? p.monthly ?? 0,
            tagline: p.tagline ?? p.description ?? '',
            features: p.features ?? p.included ?? [],
            highlight: p.highlight ?? p.popular ?? false,
            cta: p.cta ?? 'Choose plan',
          })));
        }
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <span className="grid size-8 place-items-center rounded-lg bg-primary font-bold text-primary-foreground">E</span>
            ExamFlow
          </Link>
          <div className="flex items-center gap-2">
            <SignedOut>
              <Button asChild variant="ghost" size="sm">
                <Link to="/sign-in">Sign in</Link>
              </Button>
              <Button asChild size="sm">
                <Link to="/sign-up">Get started</Link>
              </Button>
            </SignedOut>
            <SignedIn>
              <Button asChild size="sm">
                <Link to="/dashboard">Dashboard</Link>
              </Button>
            </SignedIn>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-4 py-16 text-center">
        <Badge variant="secondary" className="mb-5 gap-1.5">
          <Sparkles className="h-3.5 w-3.5" /> Simple, transparent pricing
        </Badge>
        <h1 className="mx-auto max-w-2xl text-4xl font-extrabold tracking-tight">Plans that scale with your exams</h1>
        <p className="mx-auto mt-4 max-w-xl text-lg text-muted-foreground">
          Start free. Upgrade when you need live proctoring, deeper analytics and higher candidate limits.
        </p>

        <div className="mt-8 inline-flex items-center gap-3 rounded-full border px-4 py-2">
          <Label className="text-sm text-muted-foreground">Monthly</Label>
          <Switch checked={annual} onCheckedChange={setAnnual} aria-label="Toggle annual billing" />
          <Label className="text-sm font-medium">Annual <span className="text-primary">(save 20%)</span></Label>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-20">
        {loading ? (
          <div className="grid gap-6 md:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Card key={i}>
                <CardContent className="space-y-4 p-6">
                  <Skeleton className="h-6 w-24" />
                  <Skeleton className="h-10 w-32" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-5/6" />
                  <Skeleton className="h-4 w-4/6" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <div className="grid gap-6 md:grid-cols-3">
            {plans.map((plan) => (
              <Card
                key={plan.code}
                className={plan.highlight ? 'relative border-primary shadow-lg' : 'relative'}
              >
                {plan.highlight ? (
                  <Badge className="absolute -top-3 left-1/2 -translate-x-1/2">Most popular</Badge>
                ) : null}
                <CardContent className="flex h-full flex-col p-6">
                  <h3 className="text-lg font-semibold">{plan.name}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{plan.tagline}</p>
                  <div className="mt-5 flex items-end gap-1">
                    <span className="text-4xl font-extrabold tracking-tight">
                      {formatPrice(annual ? plan.priceAnnual : plan.priceMonthly, annual)}
                    </span>
                    {plan.priceMonthly != null && plan.priceMonthly > 0 ? (
                      <span className="pb-1 text-sm text-muted-foreground">/ {annual ? 'year' : 'month'}</span>
                    ) : null}
                  </div>
                  <ul className="mt-6 flex-1 space-y-2.5 text-sm">
                    {plan.features.map((feature) => (
                      <li key={feature} className="flex items-start gap-2">
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-6 w-full">
                    <SignedIn>
                      <Button asChild className="w-full" variant={plan.highlight ? 'default' : 'outline'}>
                        <Link to="/billing">{plan.priceMonthly == null ? 'Contact sales' : 'Manage billing'}</Link>
                      </Button>
                    </SignedIn>
                    <SignedOut>
                      <Button asChild className="w-full" variant={plan.highlight ? 'default' : 'outline'}>
                        <Link to="/sign-up">{plan.cta}</Link>
                      </Button>
                    </SignedOut>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        <p className="mt-10 text-center text-sm text-muted-foreground">
          All prices in USD. Cancel anytime — see{' '}
          <Link to="/" className="underline hover:text-foreground">
            full feature list
          </Link>
          .
        </p>
      </section>
    </div>
  );
}
