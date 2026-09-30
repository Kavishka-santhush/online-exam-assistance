import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const alertVariants = cva(
  'relative w-full rounded-lg border p-4 [&>svg~*]:pl-7 [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:text-foreground',
  {
    variants: {
      variant: {
        default: 'bg-background text-foreground',
        destructive: 'border-destructive/50 text-destructive dark:border-destructive [&>svg]:text-destructive bg-destructive/5',
        warning: 'border-amber-500/50 text-amber-800 dark:text-amber-300 bg-amber-500/5 [&>svg]:text-amber-600',
        info: 'border-sky-500/50 text-sky-800 dark:text-sky-300 bg-sky-500/5 [&>svg]:text-sky-600',
        success: 'border-emerald-500/50 text-emerald-800 dark:text-emerald-300 bg-emerald-500/5 [&>svg]:text-emerald-600',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

const Alert = ({ className, variant, ...props }) => <div role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
Alert.displayName = 'Alert';

const AlertTitle = ({ className, ...props }) => <h5 className={cn('mb-1 font-medium leading-none tracking-tight', className)} {...props} />;
AlertTitle.displayName = 'AlertTitle';

const AlertDescription = ({ className, ...props }) => <div className={cn('text-sm [&_p]:leading-relaxed', className)} {...props} />;
AlertDescription.displayName = 'AlertDescription';

export { Alert, AlertTitle, AlertDescription };
