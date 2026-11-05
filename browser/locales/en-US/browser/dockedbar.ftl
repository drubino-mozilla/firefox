# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

## Firefox Horizon: a toolbar with the address bar, docked to the top edge of
## the screen outside any Firefox window.

-dockedbar-name = Firefox Horizon

dockedbar-toggle-button =
    .label = { -dockedbar-name }
    .tooltiptext = Show or hide { -dockedbar-name } at the top of your screen

dockedbar-menu-button =
    .label = { -dockedbar-name }
    .tooltiptext = { -dockedbar-name }

dockedbar-new-tab-button =
    .label = New tab
    .tooltiptext = Open a new tab

dockedbar-menu-close =
    .label = Close { -dockedbar-name }

# Foxfood Mode opens pages from Firefox Horizon in the default browser, when
# that is another Firefox install, such as the Firefox someone uses every day.
dockedbar-menu-foxfood =
    .label = Foxfood Mode
