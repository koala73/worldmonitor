'use client';

/**
 * shadcn/ui Base Drawer — https://ui.shadcn.com/docs/components/base/drawer
 * Primitive: @base-ui/react/drawer
 *
 * Styles live in monitor.css (this Vite app has no Tailwind). Keep the same
 * data-slot / data-swipe-* surface as the registry component.
 */

import * as React from 'react';
import { Drawer as DrawerPrimitive } from '@base-ui/react/drawer';

import { cn } from '../../lib/utils';

type DrawerContextProps = {
  hasSnapPoints: boolean;
  modal: DrawerPrimitive.Root.Props['modal'];
  showSwipeHandle: boolean;
  swipeDirection: NonNullable<DrawerPrimitive.Root.Props['swipeDirection']>;
};

const DrawerContext = React.createContext<DrawerContextProps | null>(null);

function useDrawer() {
  const context = React.useContext(DrawerContext);
  if (!context) {
    throw new Error('useDrawer must be used within a Drawer.');
  }
  return context;
}

function Drawer({
  modal = true,
  showSwipeHandle = false,
  snapPoints,
  swipeDirection = 'down',
  ...props
}: DrawerPrimitive.Root.Props & {
  showSwipeHandle?: boolean;
}) {
  const hasSnapPoints = snapPoints != null && snapPoints.length > 0;
  const contextValue = React.useMemo(
    () => ({ hasSnapPoints, modal, showSwipeHandle, swipeDirection }),
    [hasSnapPoints, modal, showSwipeHandle, swipeDirection],
  );

  return (
    <DrawerContext.Provider value={contextValue}>
      <DrawerPrimitive.Root
        data-slot="drawer"
        modal={modal}
        snapPoints={snapPoints}
        swipeDirection={swipeDirection}
        {...props}
      />
    </DrawerContext.Provider>
  );
}

function DrawerTrigger({ ...props }: DrawerPrimitive.Trigger.Props) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

function DrawerPortal({ ...props }: DrawerPrimitive.Portal.Props) {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />;
}

function DrawerClose({ ...props }: DrawerPrimitive.Close.Props) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

function DrawerOverlay({ className, ...props }: DrawerPrimitive.Backdrop.Props) {
  return (
    <DrawerPrimitive.Backdrop
      data-slot="drawer-overlay"
      className={cn('wm-drawer-overlay', className)}
      {...props}
    />
  );
}

function DrawerSwipeHandle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="drawer-swipe-handle"
      aria-hidden="true"
      className={cn('wm-drawer-swipe-handle', className)}
      {...props}
    />
  );
}

function DrawerContent({
  className,
  children,
  container,
  ...props
}: DrawerPrimitive.Popup.Props & {
  container?: DrawerPrimitive.Portal.Props['container'];
}) {
  const { hasSnapPoints, modal, showSwipeHandle, swipeDirection } = useDrawer();
  const swipeAxis =
    swipeDirection === 'down' || swipeDirection === 'up' ? 'y' : 'x';

  return (
    <DrawerPortal container={container}>
      {modal === true ? <DrawerOverlay /> : null}
      <DrawerPrimitive.Viewport
        data-slot="drawer-viewport"
        data-modal={modal === true ? 'true' : 'false'}
        className="wm-drawer-viewport"
      >
        <DrawerPrimitive.Popup
          data-slot="drawer-popup"
          data-swipe-axis={swipeAxis}
          data-snap-points={hasSnapPoints ? '' : undefined}
          className={cn('wm-drawer-popup', className)}
          {...props}
        >
          {showSwipeHandle ? <DrawerSwipeHandle /> : null}
          <DrawerPrimitive.Content
            data-slot="drawer-content"
            className="wm-drawer-content"
          >
            {children}
          </DrawerPrimitive.Content>
        </DrawerPrimitive.Popup>
      </DrawerPrimitive.Viewport>
    </DrawerPortal>
  );
}

function DrawerHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="drawer-header" className={cn('wm-drawer-header', className)} {...props} />
  );
}

function DrawerFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="drawer-footer" className={cn('wm-drawer-footer', className)} {...props} />
  );
}

function DrawerTitle({ className, ...props }: DrawerPrimitive.Title.Props) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn('wm-drawer-title', className)}
      {...props}
    />
  );
}

function DrawerDescription({
  className,
  ...props
}: DrawerPrimitive.Description.Props) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn('wm-drawer-description', className)}
      {...props}
    />
  );
}

export {
  Drawer,
  DrawerPortal,
  DrawerOverlay,
  DrawerSwipeHandle,
  DrawerTrigger,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
};
