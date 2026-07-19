"use client";

import { ComponentPropsWithoutRef, MouseEvent, useId, useRef } from "react";

type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: {
    platform?: string;
  };
};

function isWindowsDevice() {
  const navigatorWithPlatform = navigator as NavigatorWithUserAgentData;
  const platform = navigatorWithPlatform.userAgentData?.platform ?? navigator.platform ?? "";

  return /windows|win32|win64/i.test(`${platform} ${navigator.userAgent}`);
}

function WindowsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 5.3 10.5 4v7H3V5.3Zm8.5-1.5L21 2.3V11h-9.5V3.8ZM3 12h7.5v7L3 17.7V12Zm8.5 0H21v8.7l-9.5-1.5V12Z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <path d="m4.5 4.5 9 9m0-9-9 9" />
    </svg>
  );
}

type WindowsDownloadLinkProps = ComponentPropsWithoutRef<"a">;

export function WindowsDownloadLink({ children, onClick, ...props }: WindowsDownloadLinkProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || isWindowsDevice()) return;

    event.preventDefault();
    dialogRef.current?.showModal();
  };

  return (
    <>
      <a {...props} onClick={handleClick}>
        {children}
      </a>

      <dialog
        ref={dialogRef}
        className="download-support-dialog"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}
      >
        <div className="download-support-dialog-content">
          <form method="dialog">
            <button className="download-support-dialog-close" type="submit" aria-label="Close dialog">
              <CloseIcon />
            </button>
          </form>

          <div className="download-support-dialog-icon">
            <WindowsIcon />
          </div>
          <h2 id={titleId}>MeshHop is supported only on Windows (for now)</h2>
          <p id={descriptionId}>
            This operating system isn&apos;t supported yet. MeshHop currently works on Windows 10 and 11,
            with support for more operating systems planned in future updates.
          </p>
          <p className="download-support-dialog-note">Stay tuned, and we&apos;ll share new platform support as it becomes available.</p>

          <form method="dialog" className="download-support-dialog-actions">
            <button type="submit" autoFocus>Got it</button>
          </form>
        </div>
      </dialog>
    </>
  );
}
