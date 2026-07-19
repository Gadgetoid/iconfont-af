# Third party notices

The font installer in `index.html` uses code derived from **MicroPython**
(https://micropython.org), which is distributed under the MIT license.

## What was derived from where

| File in this project | Derived from | Upstream copyright |
| --- | --- | --- |
| `js/romfs.js` | `tools/mpremote/mpremote/romfs.py` (the `VfsRomWriter` packer) and `extmod/vfs_rom.c` (the format specification and reader semantics) | Copyright (c) 2022 Damien P. George |
| `js/romfs-deploy.js` | `tools/mpremote/mpremote/commands.py` (`_do_romfs_query`, `_do_romfs_deploy`) | Copyright (c) 2022 Damien P. George |
| `js/mp-serial.js` | `tools/mpremote/mpremote/transport_serial.py` (raw REPL and raw-paste protocol), itself based on `tools/pyboard.py` | Copyright (c) 2014-2021 Damien P. George, Copyright (c) 2017 Paul Sokolovsky, Copyright (c) 2023 Jim Mussared |

These three files are vendored from the sibling `provision` tool. No MicroPython
source file is bundled here.

## MicroPython license

MicroPython as a whole is Copyright (c) 2013-2026 Damien P. George. The individual
files listed above carry the copyright notices shown in the table. The full license
text, reproduced from the MicroPython `LICENSE` file and from the headers of the
derived files:

```
The MIT License (MIT)

Copyright (c) 2013-2026 Damien P. George

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
