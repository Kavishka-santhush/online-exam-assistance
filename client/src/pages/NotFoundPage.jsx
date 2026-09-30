import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function NotFoundPage() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <div className="mb-6 grid size-16 place-items-center rounded-2xl bg-muted text-muted-foreground">
        <Compass className="h-8 w-8" />
      </div>
      <p className="text-5xl font-black tracking-tight text-primary">404</p>
      <h1 className="mt-3 text-xl font-semibold">This page took a different route</h1>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        The page you're looking for doesn't exist or you may not have permission to view it.
      </p>
      <div className="mt-6 flex gap-2">
        <Button asChild variant="outline">
          <Link to="/dashboard">Go to dashboard</Link>
        </Button>
        <Button asChild>
          <Link to="/">Back home</Link>
        </Button>
      </div>
    </div>
  );
}
