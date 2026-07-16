'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { SystemAlert, type SystemAlertProps } from '@/components/ui/system-alert';

type SystemToastColor = NonNullable<SystemAlertProps['color']>;

interface SystemToastOptions {
  title?: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  color?: SystemToastColor;
  layout?: SystemAlertProps['layout'];
  duration?: number;
  primaryAction?: SystemAlertProps['primaryAction'];
  secondaryAction?: SystemAlertProps['secondaryAction'];
}

function systemToast(options: SystemToastOptions) {
  const {
    title,
    description,
    icon,
    color = 'neutral',
    duration = 4000,
    primaryAction,
    secondaryAction,
  } = options;
  const layout = options.layout ?? (primaryAction || secondaryAction ? 'inline' : 'stacked');

  return toast.custom(
    (id) => (
      <SystemAlert
        color={color}
        icon={icon}
        title={title}
        layout={layout}
        showClose
        onClose={() => toast.dismiss(id)}
        primaryAction={primaryAction}
        secondaryAction={secondaryAction}
        className="shadow-lg"
      >
        {description}
      </SystemAlert>
    ),
    {
      duration,
      unstyled: true,
    }
  );
}

systemToast.success = (
  description: React.ReactNode,
  options?: Omit<SystemToastOptions, 'color' | 'description'>
) => systemToast({ color: 'success', description, ...options });

systemToast.warning = (
  description: React.ReactNode,
  options?: Omit<SystemToastOptions, 'color' | 'description'>
) => systemToast({ color: 'warning', description, ...options });

systemToast.error = (
  description: React.ReactNode,
  options?: Omit<SystemToastOptions, 'color' | 'description'>
) => systemToast({ color: 'destructive', description, ...options });

systemToast.info = (
  description: React.ReactNode,
  options?: Omit<SystemToastOptions, 'color' | 'description'>
) => systemToast({ color: 'info', description, ...options });

systemToast.primary = (
  description: React.ReactNode,
  options?: Omit<SystemToastOptions, 'color' | 'description'>
) => systemToast({ color: 'primary', description, ...options });

export { systemToast, type SystemToastOptions };
