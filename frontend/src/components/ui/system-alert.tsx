'use client';

import { cva } from 'class-variance-authority';
import { X } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const systemAlertVariants = cva(
  'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-1 relative w-full rounded-lg border p-4 transition-all duration-200 data-[state=closed]:animate-out',
  {
    variants: {
      color: {
        neutral: '',
        primary: '',
        warning: '',
        success: '',
        destructive: '',
        info: '',
      },
    },
    compoundVariants: [
      {
        color: 'neutral',
        class: 'border-neutral/15 text-neutral-strong [background:color-mix(in_srgb,var(--color-neutral-muted)_50%,var(--color-background))]',
      },
      {
        color: 'primary',
        class: 'border-primary/15 text-primary-strong [background:color-mix(in_srgb,var(--color-primary-muted)_50%,var(--color-background))]',
      },
      {
        color: 'warning',
        class: 'border-warning/15 text-warning-strong [background:color-mix(in_srgb,var(--color-warning-muted)_50%,var(--color-background))]',
      },
      {
        color: 'success',
        class: 'border-success/15 text-success-strong [background:color-mix(in_srgb,var(--color-success-muted)_50%,var(--color-background))]',
      },
      {
        color: 'destructive',
        class: 'border-destructive/15 text-destructive-strong [background:color-mix(in_srgb,var(--color-destructive-muted)_50%,var(--color-background))]',
      },
      {
        color: 'info',
        class: 'border-info/15 text-info-strong [background:color-mix(in_srgb,var(--color-info-muted)_50%,var(--color-background))]',
      },
    ],
    defaultVariants: {
      color: 'neutral',
    },
  }
);

export interface SystemAlertProps extends Omit<React.ComponentProps<'div'>, 'title' | 'color'> {
  title?: React.ReactNode;
  icon?: React.ReactNode;
  children?: React.ReactNode;
  showClose?: boolean;
  onClose?: () => void;
  autoClose?: number;
  primaryAction?: {
    label: string;
    onClick: () => void;
  };
  secondaryAction?: {
    label: string;
    onClick: () => void;
  };
  color?: 'neutral' | 'primary' | 'warning' | 'success' | 'destructive' | 'info';
  layout?: 'stacked' | 'inline';
}

function SystemAlert({
  className,
  color,
  title,
  icon,
  children,
  showClose = true,
  onClose,
  autoClose,
  primaryAction,
  secondaryAction,
  layout = 'stacked',
  ...props
}: SystemAlertProps) {
  const [isVisible, setIsVisible] = React.useState(true);
  const [state, setState] = React.useState<'open' | 'closed'>('open');
  const animationTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleClose = React.useCallback(() => {
    setState('closed');
    if (animationTimerRef.current) {
      clearTimeout(animationTimerRef.current);
    }
    animationTimerRef.current = setTimeout(() => {
      setIsVisible(false);
      onClose?.();
    }, 200);
  }, [onClose]);

  React.useEffect(() => {
    return () => {
      if (animationTimerRef.current) {
        clearTimeout(animationTimerRef.current);
      }
    };
  }, []);

  React.useEffect(() => {
    if (autoClose && autoClose > 0) {
      const timer = setTimeout(() => {
        handleClose();
      }, autoClose);

      return () => clearTimeout(timer);
    }
    return;
  }, [autoClose, handleClose]);

  if (!isVisible) {
    return null;
  }

  const hasActions = primaryAction || secondaryAction;

  return (
    <div
      aria-live={color === 'warning' || color === 'destructive' ? 'assertive' : 'polite'}
      className={cn(systemAlertVariants({ color }), 'z-50', className)}
      data-slot="system-alert"
      data-state={state}
      role={layout === 'inline' ? 'status' : 'alert'}
      {...props}
    >
      <div className={cn('flex gap-3', layout === 'inline' ? 'items-center' : 'items-start')}>
        {icon && <div className={cn('shrink-0 [&>svg]:size-5 [&>svg]:text-current', layout === 'stacked' && '-mt-0.25')}>{icon}</div>}

        {layout === 'inline' ? (
          <div className="min-w-0 flex-1 flex items-center gap-3">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              {title && (
                <div className="shrink-0 font-semibold text-sm leading-tight" data-slot="system-alert-title">
                  {title}
                </div>
              )}
              {children && (
                <div
                  className="min-w-0 text-sm leading-relaxed truncate"
                  data-slot="system-alert-description"
                >
                  {children}
                </div>
              )}
            </div>
            {hasActions && (
              <div className="flex shrink-0 items-center gap-2">
                {primaryAction && (
                  <Button className="h-7" onClick={primaryAction.onClick} size="sm" variant="outline">
                    {primaryAction.label}
                  </Button>
                )}
                {secondaryAction && (
                  <Button className="h-7" onClick={secondaryAction.onClick} size="sm" variant="ghost">
                    {secondaryAction.label}
                  </Button>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="min-w-0 flex-1 space-y-1">
            {title && (
              <div className="font-semibold text-sm leading-tight" data-slot="system-alert-title">
                {title}
              </div>
            )}
            {children && (
              <div
                className="text-sm leading-relaxed [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:leading-relaxed [&_ul]:list-disc [&_ul]:pl-4"
                data-slot="system-alert-description"
              >
                {children}
              </div>
            )}
            {hasActions && (
              <div className="flex items-center gap-2 pt-1">
                {primaryAction && (
                  <Button className="h-8" onClick={primaryAction.onClick} size="sm" variant="outline">
                    {primaryAction.label}
                  </Button>
                )}
                {secondaryAction && (
                  <Button className="h-8" onClick={secondaryAction.onClick} size="sm" variant="ghost">
                    {secondaryAction.label}
                  </Button>
                )}
              </div>
            )}
          </div>
        )}

        {showClose && (
          <button
            aria-label="Close alert"
            className="shrink-0 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            onClick={handleClose}
            type="button"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}

export { SystemAlert, systemAlertVariants };
