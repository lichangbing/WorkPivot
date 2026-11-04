import React from 'react';
import {
  deliveryStatusDescription,
  deliveryStatusLabel,
  type RequestDeliveryView,
} from '@workpivot/shared';

const tone = (view: RequestDeliveryView): string => {
  if (view.deliveryState === 'delivered') return 'done';
  if (view.deliveryState === 'blocked') return view.kind === 'waiting_user' ? 'waiting' : 'blocked';
  if (view.deliveryState === 'acknowledged') return 'active';
  return 'accepted';
};

export function RequestDeliveryStatus({ view, onResume }: {
  view: RequestDeliveryView;
  onResume?: () => void;
}) {
  return <div className={`delivery-status ${tone(view)}`} role="status" aria-live="polite">
    <span className="delivery-status-label">{deliveryStatusLabel(view)}</span>
    <span className="delivery-status-description">{deliveryStatusDescription(view)}</span>
    {view.kind === 'interrupted' && onResume && <button type="button" className="delivery-status-action" onClick={onResume}>继续</button>}
  </div>;
}
