/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "WinAppBar.h"

#include <dwmapi.h>
#include <shellapi.h>

#include <algorithm>

namespace mozilla::widget {

// The window's own surface is see-through wherever it is this color. The
// compositor child window draws Firefox's content on top of it, and Firefox
// clears the translucent parts of the surface to black.
static constexpr COLORREF kTransparentColorKey = RGB(0, 0, 0);
// Painted under the parts of the window that take clicks. Always covered by
// opaque content, so never visible.
static constexpr COLORREF kHitTestColor = RGB(1, 1, 1);

WinAppBar::WinAppBar(HWND aWnd) : mWnd(aWnd) {
  LONG_PTR style = ::GetWindowLongPtrW(mWnd, GWL_STYLE);
  LONG_PTR exStyle = ::GetWindowLongPtrW(mWnd, GWL_EXSTYLE);
  style &= ~(WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX |
             WS_MAXIMIZEBOX);
  exStyle = (exStyle | WS_EX_TOOLWINDOW | WS_EX_LAYERED) & ~WS_EX_APPWINDOW;

  // The taskbar only notices the tool window style if the window is hidden
  // while it changes.
  const bool visible = ::IsWindowVisible(mWnd);
  if (visible) {
    ::ShowWindow(mWnd, SW_HIDE);
  }
  ::SetWindowLongPtrW(mWnd, GWL_STYLE, style);
  ::SetWindowLongPtrW(mWnd, GWL_EXSTYLE, exStyle);
  ::SetLayeredWindowAttributes(mWnd, kTransparentColorKey, 0, LWA_COLORKEY);
  ::SetWindowPos(mWnd, nullptr, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE |
                     SWP_FRAMECHANGED);
  if (visible) {
    ::ShowWindow(mWnd, SW_SHOWNA);
  }

  DWM_SYSTEMBACKDROP_TYPE backdrop = DWMSBT_NONE;
  ::DwmSetWindowAttribute(mWnd, DWMWA_SYSTEMBACKDROP_TYPE, &backdrop,
                          sizeof(backdrop));
  DWM_WINDOW_CORNER_PREFERENCE corners = DWMWCP_DONOTROUND;
  ::DwmSetWindowAttribute(mWnd, DWMWA_WINDOW_CORNER_PREFERENCE, &corners,
                          sizeof(corners));
  COLORREF border = DWMWA_COLOR_NONE;
  ::DwmSetWindowAttribute(mWnd, DWMWA_BORDER_COLOR, &border, sizeof(border));

  mCallbackMessage = ::RegisterWindowMessageW(L"MozillaAppBarNotify");
  APPBARDATA data{sizeof(data)};
  data.hWnd = mWnd;
  data.uCallbackMessage = mCallbackMessage;
  mRegistered = ::SHAppBarMessage(ABM_NEW, &data);
}

WinAppBar::~WinAppBar() {
  if (mRegistered) {
    APPBARDATA data{sizeof(data)};
    data.hWnd = mWnd;
    ::SHAppBarMessage(ABM_REMOVE, &data);
  }
}

void WinAppBar::SetReservedHeight(int32_t aHeight) {
  if (aHeight == mReservedHeight) {
    return;
  }
  mReservedHeight = aHeight;
  Reserve();
  MoveIntoReservedStrip();
}

void WinAppBar::SetWindowHeight(int32_t aHeight) {
  if (aHeight == mWindowHeight) {
    return;
  }
  mWindowHeight = aHeight;
  MoveIntoReservedStrip();
}

void WinAppBar::SetHitRegions(nsTArray<HitRegion>&& aRegions) {
  mHitRegions = std::move(aRegions);
  PaintNow();
}

int32_t WinAppBar::WindowHeight() const {
  return std::max(mWindowHeight, mReservedHeight);
}

void WinAppBar::Reserve() {
  if (!mRegistered) {
    return;
  }
  MONITORINFO monitorInfo{sizeof(monitorInfo)};
  ::GetMonitorInfoW(::MonitorFromWindow(mWnd, MONITOR_DEFAULTTONEAREST),
                    &monitorInfo);
  const RECT& monitor = monitorInfo.rcMonitor;

  APPBARDATA data{sizeof(data)};
  data.hWnd = mWnd;
  data.uEdge = ABE_TOP;
  data.rc = {monitor.left, monitor.top, monitor.right,
             monitor.top + mReservedHeight};
  ::SHAppBarMessage(ABM_QUERYPOS, &data);
  data.rc.bottom = data.rc.top + mReservedHeight;
  ::SHAppBarMessage(ABM_SETPOS, &data);
  mReserved = data.rc;
}

void WinAppBar::MoveIntoReservedStrip() {
  if (!mReservedHeight) {
    return;
  }
  // OnWindowPosChanging pins the window to the strip.
  ::SetWindowPos(mWnd, nullptr, mReserved.left, mReserved.top,
                 mReserved.right - mReserved.left, WindowHeight(),
                 SWP_NOZORDER | SWP_NOACTIVATE);
  PaintNow();
}

void WinAppBar::OnNotification(WPARAM aWParam, LPARAM aLParam) {
  switch (aWParam) {
    case ABN_POSCHANGED:
      Reserve();
      MoveIntoReservedStrip();
      break;
    case ABN_FULLSCREENAPP: {
      const bool fullscreen = !!aLParam;
      if (fullscreen != mHiddenForFullscreen) {
        mHiddenForFullscreen = fullscreen;
        ::ShowWindow(mWnd, fullscreen ? SW_HIDE : SW_SHOWNA);
      }
      break;
    }
  }
}

void WinAppBar::OnWindowPosChanging(WINDOWPOS* aInfo) {
  // Firefox constrains windows to the work area, which the shell shrinks by
  // the strip this window reserves, pushing the window out of its own strip.
  if (!mReservedHeight) {
    return;
  }
  if (!(aInfo->flags & SWP_NOMOVE)) {
    aInfo->x = mReserved.left;
    aInfo->y = mReserved.top;
  }
  if (!(aInfo->flags & SWP_NOSIZE)) {
    aInfo->cx = mReserved.right - mReserved.left;
    aInfo->cy = WindowHeight();
  }
}

void WinAppBar::PaintNow() {
  if (HDC dc = ::GetDC(mWnd)) {
    Paint(dc);
    ::ReleaseDC(mWnd, dc);
  }
}

void WinAppBar::Paint(HDC aDC) {
  static HBRUSH sTransparentBrush = ::CreateSolidBrush(kTransparentColorKey);
  static HBRUSH sHitTestBrush = ::CreateSolidBrush(kHitTestColor);

  RECT client;
  ::GetClientRect(mWnd, &client);
  ::FillRect(aDC, &client, sTransparentBrush);

  RECT strip = client;
  strip.bottom = std::min<LONG>(client.bottom, mReservedHeight);
  ::FillRect(aDC, &strip, sHitTestBrush);

  for (const HitRegion& region : mHitRegions) {
    // Stay a little inside rounded corners, where the content is opaque.
    const int32_t diameter = region.mRadius ? region.mRadius * 2 + 4 : 0;
    HRGN hrgn = ::CreateRoundRectRgn(region.mRect.X() + 1, region.mRect.Y() + 1,
                                     region.mRect.XMost(), region.mRect.YMost(),
                                     diameter, diameter);
    ::FillRgn(aDC, hrgn, sHitTestBrush);
    ::DeleteObject(hrgn);
  }
}

}  // namespace mozilla::widget
