import { ArrowUpRight } from 'lucide-react';

// Shared fragments for the welcome card-link grids (TaskRoutes, Agents
// resources). The RTL mirror + hover nudge and the focus ring must stay
// identical across grids — an RTL or focus fix applied to one inline copy
// and not the other is exactly the drift this file exists to prevent.
export const cardLinkFocusRing =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-wm-green';

export const CardLinkArrow = ({ className }: { className?: string }) => (
  <ArrowUpRight
    className={`h-3.5 w-3.5 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5${className ? ` ${className}` : ''}`}
    aria-hidden="true"
  />
);
