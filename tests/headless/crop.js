// SPDX-License-Identifier: GPL-2.0-or-later
// Crops headless test screenshots into screenshots/ for the README.
// Usage: gjs -m crop.js <out-dir> <screenshots-dir>
import GdkPixbuf from 'gi://GdkPixbuf';

const [out, dest] = ARGV;
const crop = (name, x, y, w, h) => {
    const pb = GdkPixbuf.Pixbuf.new_from_file(`${out}/${name}.png`);
    const left = x < 0 ? pb.get_width() + x : x;
    pb.new_subpixbuf(left, y, w, h).savev(`${dest}/${name}.png`, 'png', [], []);
};
crop('menu-dark', -430, 0, 430, 760);
crop('menu-light', -430, 0, 430, 810);
crop('prefs', 490, 80, 620, 860);
