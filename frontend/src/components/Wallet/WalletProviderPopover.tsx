import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { WalletType } from "@goblinhunt/cosmes/wallet";
import type { WalletProviderId } from "../../lib/walletProviders";
import { WalletProviderOptions } from "./WalletProviderOptions";

// Portal-rendered wallet picker, for callers whose trigger button sits
// inside a clip-path ancestor (eg. the onramp's .pixel-stepped-corners
// frames) - a plain position:absolute dropdown gets cropped by that
// clip-path same as overflow:hidden would, no matter how high its z-index
// is (found live: the menu was rendering almost entirely below the visible
// card, only a sliver of its border peeking out). Rendering into
// document.body with position:fixed, positioned from the trigger's own
// getBoundingClientRect(), escapes that entirely - and flips upward when
// there isn't enough room below, so a trigger near the bottom of the
// viewport doesn't push the menu off-screen either.
export function WalletProviderPopover({
  anchorRef,
  onClose,
  onSelect,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSelect: (providerId: WalletProviderId, type: WalletType) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<{ top: number; left: number } | null>(null);

  // Split out from the layout effect below so scroll/resize can re-run the
  // same measurement (found in CodeRabbit review, PR #35: position:fixed
  // means the menu stayed at its old viewport coordinates and visibly
  // detached from the trigger on scroll/resize otherwise).
  const position = useCallback(() => {
    const anchor = anchorRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const anchorRect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const spaceBelow = window.innerHeight - anchorRect.bottom;
    const openUpward = spaceBelow < menuRect.height + 8 && anchorRect.top > menuRect.height + 8;
    const top = openUpward ? anchorRect.top - menuRect.height - 6 : anchorRect.bottom + 6;
    const left = Math.min(
      Math.max(anchorRect.right - menuRect.width, 8),
      window.innerWidth - menuRect.width - 8
    );
    setStyle({ top, left });
  }, [anchorRef]);

  useLayoutEffect(() => {
    position();
    // capture:true - scroll events on an inner scrollable ancestor (not
    // just the window) don't bubble, capture is the only way to catch those
    // too.
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    return () => {
      window.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
    };
  }, [position]);

  useEffect(() => {
    function handlePointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    }
    // Escape + returning focus to the trigger - missing entirely before
    // (found in CodeRabbit review, PR #35): a keyboard-only user had no way
    // to close this menu or move focus into it, since it renders into
    // document.body after the trigger in DOM order (Tab from the trigger
    // skipped past it to whatever's next in the page, not into the menu).
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      anchorRef.current?.focus();
      onClose();
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [anchorRef, onClose]);

  // Focus the first option once the menu has a measured position, so Tab
  // order continues inside the portal instead of skipping past it. Guarded
  // to fire only once (not on every `style` update) - `position` above now
  // also runs on scroll/resize, which would otherwise yank focus back to
  // the first option every time the user scrolls while further into the
  // menu.
  const hasFocusedRef = useRef(false);
  useEffect(() => {
    if (!style || hasFocusedRef.current) return;
    hasFocusedRef.current = true;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [style]);

  return createPortal(
    <div
      ref={menuRef}
      className="wallet-provider-menu wallet-provider-menu-portal"
      role="menu"
      // Hidden (not unrendered) until the first layout pass measures the
      // real menu size above - avoids a visible jump from a wrong initial
      // position.
      style={style ?? { visibility: "hidden", top: 0, left: 0 }}
    >
      <WalletProviderOptions onSelect={onSelect} />
    </div>,
    document.body
  );
}
