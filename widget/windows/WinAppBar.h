/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef widget_windows_WinAppBar_h
#define widget_windows_WinAppBar_h

#include <windows.h>

#include "Units.h"
#include "nsTArray.h"

namespace mozilla::widget {

/**
 * Docks a top-level window to the top edge of its monitor as an application
 * desktop toolbar ("appbar"), like the taskbar: the shell keeps other windows,
 * maximized ones included, out of the strip the appbar reserves.
 *
 * The window becomes a borderless tool window, so it has no taskbar button and
 * is left out of Alt+Tab. It is also a color-keyed layered window: its own
 * surface is see-through and lets clicks through wherever it is black, which
 * is everywhere Firefox's compositor child window draws transparent content.
 * The reserved strip and the regions set with SetHitRegions are painted a
 * non-key color underneath the content, so they take clicks.
 *
 * The window is hidden while the shell reports a full screen app.
 */
class WinAppBar final {
 public:
  struct HitRegion {
    LayoutDeviceIntRect mRect;
    int32_t mRadius = 0;
  };

  explicit WinAppBar(HWND aWnd);
  ~WinAppBar();

  WinAppBar(const WinAppBar&) = delete;
  WinAppBar& operator=(const WinAppBar&) = delete;

  UINT CallbackMessage() const { return mCallbackMessage; }

  /**
   * Reserves a strip aHeight device pixels tall across the top of the
   * window's monitor, and moves the window into it.
   */
  void SetReservedHeight(int32_t aHeight);

  /**
   * Sets the height of the window, which may extend below the reserved strip.
   * Zero or less makes the window as tall as the strip.
   */
  void SetWindowHeight(int32_t aHeight);

  /**
   * Sets the parts of the window below the reserved strip that take clicks,
   * in device pixels relative to the client area.
   */
  void SetHitRegions(nsTArray<HitRegion>&& aRegions);

  void OnNotification(WPARAM aWParam, LPARAM aLParam);
  void OnWindowPosChanging(WINDOWPOS* aInfo);
  void Paint(HDC aDC);

 private:
  void Reserve();
  void MoveIntoReservedStrip();
  void PaintNow();
  int32_t WindowHeight() const;

  HWND mWnd;
  UINT mCallbackMessage = 0;
  bool mRegistered = false;
  RECT mReserved{};
  int32_t mReservedHeight = 0;
  int32_t mWindowHeight = 0;
  nsTArray<HitRegion> mHitRegions;
  bool mHiddenForFullscreen = false;
};

}  // namespace mozilla::widget

#endif  // widget_windows_WinAppBar_h
