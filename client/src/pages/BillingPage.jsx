import { useCallback, useEffect, useState } from 'react';
import { Check, Download, CreditCard, Loader2, Sparkles } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/hooks/useRedux';
import { selectActiveOrganization, selectIsStaff } from '@/store/slices/authSlice';
import { toast } from '@/store/slices/uiSlice';
import { request, endpoints } from '@/lib/apiClient';
import { downloadFromEndpoint } from '@/utils/download';
import { PageHeader } from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Separator } from '@/components/ui/separator';

const money = (cents, currency = 'usd') =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: (currency || 'usd').toUpperCase() }).format((cents ?? 0) / 100);

/**
 * Billing (`/billing`).
 *
 * Candidates see their invoice history; org admins additionally see the live
 * subscription + plan-upgrade panel (Stripe is created server-side, we just
 * call `/payments/subscriptions/*` and follow the returned checkout URL). We
 * never build a Stripe session or touch card data here — the server owns the
 * payment intent and returns a redirect, keeping PCI scope off the SPA.
 */
export default function BillingPage() {
  const dispatch = useAppDispatch();
  const org = useAppSelector(selectActiveOrganization);
  const isStaff = useAppSelector(selectIsStaff);

  const [plans, setPlans] = useState(null);
  const [subscription, setSubscription] = useState(null);
  const [invoices, setInvoices] = useState(null);
  const [busyPlan, setBusyPlan] = useState(null);

  const loadSub = useCallback(() => {
    if (!isStaff || !org?.id) return;
    request.get(endpoints.payments.subscription(org.id)).then(setSubscription).catch(() => setSubscription(null));
  }, [isStaff, org?.id]);

  useEffect(() => {
    request.get(endpoints.payments.plans).then((data) => setPlans(Array.isArray(data) ? data : data?.items ?? [])).catch(() => setPlans([]));
    request.paged(endpoints.payments.invoices, { params: { limit: 50 } }).then(({ data }) => setInvoices(data)).catch(() => setInvoices([]));
    loadSub();
  }, [loadSub]);

  async function choosePlan(plan) {
    if (!org?.id) { dispatch(toast({ title: 'Select an organization first', variant: 'info' })); return; }
    setBusyPlan(plan.code);
    try {
      const result = await request.post(endpoints.payments.upgrade, { organizationId: org.id, planCode: plan.code });
      if (result?.checkoutUrl) window.location.assign(result.checkoutUrl);
      else { loadSub(); dispatch(toast({ title: 'Plan updated', description: `${plan.name} is now active.`, variant: 'success' })); }
    } catch (err) {
      dispatch(toast({ title: 'Upgrade failed', description: err.message, variant: 'error' }));
    } finally {
      setBusyPlan(null);
    }
  }

  async function cancelPlan() {
    if (!org?.id) return;
    try {
      await request.post(endpoints.payments.cancel, { organizationId: org.id });
      loadSub();
      dispatch(toast({ title: 'Subscription will not renew', variant: 'success' }));
    } catch (err) {
      dispatch(toast({ title: 'Cancel failed', description: err.message, variant: 'error' }));
    }
  }

  const currentCode = subscription?.plan?.code;

  return (
    <div className="space-y-6">
      <PageHeader title="Billing" description={isStaff ? 'Your plan, usage limits, and invoices.' : 'Your payment history.'} breadcrumb={[{ label: 'Billing' }]} />

      {isStaff ? (
        <Card className="border-primary/30">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base"><CreditCard className="h-4 w-4" /> Current subscription</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {org?.id === null || subscription === null ? (
              plans === null ? <Skeleton className="h-16" /> : (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-semibold">Free plan</p>
                    <p className="text-sm text-muted-foreground">You haven't subscribed to a paid plan yet.</p>
                  </div>
                </div>
              )
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="flex items-center gap-2 font-semibold">{subscription.plan?.name ?? subscription.plan?.code} <Badge variant="success">{subscription.status}</Badge></p>
                  <p className="text-sm text-muted-foreground">
                    {subscription.currentPeriodEnd ? `Renews ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}` : 'No auto-renew'}
                  </p>
                </div>
                {subscription.status === 'ACTIVE' ? <Button variant="outline" size="sm" onClick={cancelPlan}>Cancel renewal</Button> : null}
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      {isStaff ? (
        <div className="grid gap-4 md:grid-cols-3">
          {(plans ?? []).map((plan) => {
            const isCurrent = plan.code === currentCode;
            const features = Array.isArray(plan.features) ? plan.features : [];
            return (
              <Card key={plan.id} className={plan.isPopular ? 'border-primary' : undefined}>
                <CardContent className="flex h-full flex-col p-5">
                  <div className="mb-1 flex items-center justify-between">
                    <h3 className="font-semibold">{plan.name}</h3>
                    {plan.isPopular ? <Badge variant="default" className="gap-1"><Sparkles className="h-3 w-3" /> Popular</Badge> : null}
                  </div>
                  <p className="text-sm text-muted-foreground line-clamp-2">{plan.description}</p>
                  <div className="my-3">
                    <span className="text-2xl font-black">{money(plan.priceMonthly, plan.currency)}</span>
                    <span className="text-sm text-muted-foreground">/mo</span>
                  </div>
                  <ul className="mb-4 space-y-1.5 text-sm">
                    {features.slice(0, 5).map((feature) => (
                      <li key={feature} className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" /> <span>{feature}</span></li>
                    ))}
                    <li className="flex items-start gap-2 text-muted-foreground"><Check className="mt-0.5 h-4 w-4 shrink-0" /> Up to {plan.maxExams} exams · {plan.maxCandidatesPerExam} candidates each</li>
                  </ul>
                  <div className="mt-auto">
                    <Button className="w-full" variant={isCurrent ? 'outline' : 'default'} disabled={isCurrent || busyPlan === plan.code} onClick={() => choosePlan(plan)}>
                      {busyPlan === plan.code ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                      {isCurrent ? 'Current plan' : plan.priceMonthly === 0 ? 'Switch to Free' : 'Choose plan'}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : null}

      <Separator />

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Invoices</CardTitle></CardHeader>
        <CardContent className="p-0">
          {!invoices ? (
            <div className="space-y-2 p-4">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
          ) : invoices.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No invoices yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow><TableHead>Number</TableHead><TableHead>Plan / item</TableHead><TableHead>Date</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Status</TableHead><TableHead className="w-16" /></TableRow>
              </TableHeader>
              <TableBody>
                {invoices.map((invoice) => (
                  <TableRow key={invoice.id}>
                    <TableCell className="font-mono text-xs">{invoice.number ?? invoice.id}</TableCell>
                    <TableCell>{invoice.description ?? invoice.plan?.name ?? 'Payment'}</TableCell>
                    <TableCell className="text-muted-foreground">{invoice.createdAt || invoice.issuedAt ? new Date(invoice.createdAt ?? invoice.issuedAt).toLocaleDateString() : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(invoice.amountCents, invoice.currency)}</TableCell>
                    <TableCell><Badge variant={invoice.status === 'PAID' || invoice.status === 'SUCCEEDED' ? 'success' : invoice.status === 'REFUNDED' ? 'secondary' : 'warning'}>{invoice.status}</Badge></TableCell>
                    <TableCell className="text-right">
                      <Button size="icon" variant="ghost" aria-label="Download" onClick={() => downloadFromEndpoint(endpoints.reports.invoicePdf, `invoice-${invoice.id}.pdf`, { params: { invoiceId: invoice.id } }).catch(() => dispatch(toast({ title: 'Download failed', variant: 'error' })))}>
                        <Download className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
