// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Lang = imports.lang;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;
const Signals = imports.signals;
const St = imports.gi.St;

const GrabHelper = imports.ui.grabHelper;
const Lightbox = imports.ui.lightbox;
const Main = imports.ui.main;
const Tweener = imports.ui.tweener;

const ScreenshotIface = '<node> \
<interface name="org.gnome.Shell.Screenshot"> \
<method name="ScreenshotArea"> \
    <arg type="i" direction="in" name="x"/> \
    <arg type="i" direction="in" name="y"/> \
    <arg type="i" direction="in" name="width"/> \
    <arg type="i" direction="in" name="height"/> \
    <arg type="b" direction="in" name="flash"/> \
    <arg type="s" direction="in" name="filename"/> \
    <arg type="b" direction="out" name="success"/> \
    <arg type="s" direction="out" name="filename_used"/> \
</method> \
<method name="ScreenshotWindow"> \
    <arg type="b" direction="in" name="include_frame"/> \
    <arg type="b" direction="in" name="include_cursor"/> \
    <arg type="b" direction="in" name="flash"/> \
    <arg type="s" direction="in" name="filename"/> \
    <arg type="b" direction="out" name="success"/> \
    <arg type="s" direction="out" name="filename_used"/> \
</method> \
<method name="Screenshot"> \
    <arg type="b" direction="in" name="include_cursor"/> \
    <arg type="b" direction="in" name="flash"/> \
    <arg type="s" direction="in" name="filename"/> \
    <arg type="b" direction="out" name="success"/> \
    <arg type="s" direction="out" name="filename_used"/> \
</method> \
<method name="SelectArea"> \
    <arg type="i" direction="out" name="x"/> \
    <arg type="i" direction="out" name="y"/> \
    <arg type="i" direction="out" name="width"/> \
    <arg type="i" direction="out" name="height"/> \
</method> \
<method name="FlashArea"> \
    <arg type="i" direction="in" name="x"/> \
    <arg type="i" direction="in" name="y"/> \
    <arg type="i" direction="in" name="width"/> \
    <arg type="i" direction="in" name="height"/> \
</method> \
</interface> \
</node>';

const ScreenshotService = new Lang.Class({
    Name: 'ScreenshotService',

    _init: function() {
        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(ScreenshotIface, this);
        this._dbusImpl.export(Gio.DBus.session, '/org/gnome/Shell/Screenshot');

        Gio.DBus.session.own_name('org.gnome.Shell.Screenshot', Gio.BusNameOwnerFlags.REPLACE, null, null);
    },

    _checkArea: function(x, y, width, height) {
        return x >= 0 && y >= 0 &&
               width > 0 && height > 0 &&
               x + width <= global.screen_width &&
               y + height <= global.screen_height;
    },

    _onScreenshotComplete: function(obj, result, area, filenameUsed, flash, invocation) {
        if (flash && result) {
            let flashspot = new Flashspot(area);
            flashspot.fire();
        }

        let retval = GLib.Variant.new('(bs)', [result, filenameUsed]);
        invocation.return_value(retval);
    },

    _scaleArea: function(x, y, width, height) {
        let scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        x *= scaleFactor;
        y *= scaleFactor;
        width *= scaleFactor;
        height *= scaleFactor;
        return [x, y, width, height];
    },

    _unscaleArea: function(x, y, width, height) {
        let scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        x /= scaleFactor;
        y /= scaleFactor;
        width /= scaleFactor;
        height /= scaleFactor;
        return [x, y, width, height];
    },

    ScreenshotAreaAsync : function (params, invocation) {
        let [x, y, width, height, flash, filename, callback] = params;
        [x, y, width, height] = this._scaleArea(x, y, width, height);
        if (!this._checkArea(x, y, width, height)) {
            invocation.return_error_literal(Gio.IOErrorEnum,
                                            Gio.IOErrorEnum.CANCELLED,
                                            "Invalid params");
            return;
        }
        let screenshot = new Shell.Screenshot();
        screenshot.screenshot_area (x, y, width, height, filename,
                                Lang.bind(this, this._onScreenshotComplete,
                                          flash, invocation));
    },

    ScreenshotWindowAsync : function (params, invocation) {
        let [include_frame, include_cursor, flash, filename] = params;
        let screenshot = new Shell.Screenshot();
        screenshot.screenshot_window (include_frame, include_cursor, filename,
                                  Lang.bind(this, this._onScreenshotComplete,
                                            flash, invocation));
    },

    ScreenshotAsync : function (params, invocation) {
        let [include_cursor, flash, filename] = params;
        let screenshot = new Shell.Screenshot();
        screenshot.screenshot(include_cursor, filename,
                          Lang.bind(this, this._onScreenshotComplete,
                                    flash, invocation));
    },

    SelectAreaAsync: function (params, invocation) {
        let selectArea = new SelectArea();
        selectArea.show();
        selectArea.connect('finished', Lang.bind(this,
            function(selectArea, areaRectangle) {
                if (areaRectangle) {
                    let retRectangle = this._unscaleArea(areaRectangle.x, areaRectangle.y,
                        areaRectangle.width, areaRectangle.height);
                    let retval = GLib.Variant.new('(iiii)', retRectangle);
                    invocation.return_value(retval);
                } else {
                    invocation.return_error_literal(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED,
                        "Operation was cancelled");
                }
            }));
    },

    FlashAreaAsync: function(params, invocation) {
        let [x, y, width, height] = params;
        [x, y, width, height] = this._scaleArea(x, y, width, height);
        if (!this._checkArea(x, y, width, height)) {
            invocation.return_error_literal(Gio.IOErrorEnum,
                                            Gio.IOErrorEnum.CANCELLED,
                                            "Invalid params");
            return;
        }
        let flashspot = new Flashspot({ x : x, y : y, width: width, height: height});
        flashspot.fire();
        invocation.return_value(null);
    }
});

const SelectArea = new Lang.Class({
    Name: 'SelectArea',

    _init: function() {
        this._startX = -1;
        this._startY = -1;
        this._lastX = 0;
        this._lastY = 0;
        this._result = null;

        this._initRubberbandColors();

        this._group = new St.Widget({ visible: false,
                                      reactive: true,
                                      x: 0,
                                      y: 0 });
        Main.uiGroup.add_actor(this._group);

        this._grabHelper = new GrabHelper.GrabHelper(this._group);

        this._group.connect('button-press-event',
                            Lang.bind(this, this._onButtonPress));
        this._group.connect('button-release-event',
                            Lang.bind(this, this._onButtonRelease));
        this._group.connect('motion-event',
                            Lang.bind(this, this._onMotionEvent));

        let constraint = new Clutter.BindConstraint({ source: global.stage,
                                                      coordinate: Clutter.BindCoordinate.ALL });
        this._group.add_constraint(constraint);

        this._rubberband = new Clutter.Rectangle({ color: this._background,
                                                   has_border: true,
                                                   border_width: 1,
                                                   border_color: this._border });
        this._group.add_actor(this._rubberband);
    },

    show: function() {
        if (!this._grabHelper.grab({ actor: this._group,
                                     onUngrab: Lang.bind(this, this._onUngrab) }))
            return;

        global.screen.set_cursor(Meta.Cursor.CROSSHAIR);
        Main.uiGroup.set_child_above_sibling(this._group, null);
        this._group.visible = true;
    },

    _initRubberbandColors: function() {
        function colorFromRGBA(rgba) {
            return new Clutter.Color({ red: rgba.red * 255,
                                       green: rgba.green * 255,
                                       blue: rgba.blue * 255,
                                       alpha: rgba.alpha * 255 });
        }

        let path = new Gtk.WidgetPath();
        path.append_type(Gtk.IconView);

        let context = new Gtk.StyleContext();
        context.set_path(path);
        context.add_class('rubberband');

        this._background = colorFromRGBA(context.get_background_color(Gtk.StateFlags.NORMAL));
        this._border = colorFromRGBA(context.get_border_color(Gtk.StateFlags.NORMAL));
    },

    _getGeometry: function() {
        return { x: Math.min(this._startX, this._lastX),
                 y: Math.min(this._startY, this._lastY),
                 width: Math.abs(this._startX - this._lastX),
                 height: Math.abs(this._startY - this._lastY) };
    },

    _onMotionEvent: function(actor, event) {
        if (this._startX == -1 || this._startY == -1)
            return Clutter.EVENT_PROPAGATE;

        [this._lastX, this._lastY] = event.get_coords();
        let geometry = this._getGeometry();

        this._rubberband.set_position(geometry.x, geometry.y);
        this._rubberband.set_size(geometry.width, geometry.height);

        return Clutter.EVENT_PROPAGATE;
    },

    _onButtonPress: function(actor, event) {
        [this._startX, this._startY] = event.get_coords();
        this._rubberband.set_position(this._startX, this._startY);

        return Clutter.EVENT_PROPAGATE;
    },

    _onButtonRelease: function(actor, event) {
        this._result = this._getGeometry();
        Tweener.addTween(this._group,
                         { opacity: 0,
                           time: 0.2,
                           transition: 'easeOutQuad',
                           onComplete: Lang.bind(this,
                               function() {
                                   this._grabHelper.ungrab();
                               })
                         });
        return Clutter.EVENT_PROPAGATE;
    },

    _onUngrab: function() {
        global.screen.set_cursor(Meta.Cursor.DEFAULT);
        this.emit('finished', this._result);

        GLib.idle_add(GLib.PRIORITY_DEFAULT, Lang.bind(this,
            function() {
                this._group.destroy();
                return GLib.SOURCE_REMOVE;
            }));
    }
});
Signals.addSignalMethods(SelectArea.prototype);

const FLASHSPOT_ANIMATION_OUT_TIME = 0.5; // seconds

const Flashspot = new Lang.Class({
    Name: 'Flashspot',
    Extends: Lightbox.Lightbox,

    _init: function(area) {
        this.parent(Main.uiGroup, { inhibitEvents: true,
                                    width: area.width,
                                    height: area.height });

        this.actor.style_class = 'flashspot';
        this.actor.set_position(area.x, area.y);
    },

    fire: function() {
        this.actor.show();
        this.actor.opacity = 255;
        Tweener.addTween(this.actor,
                         { opacity: 0,
                           time: FLASHSPOT_ANIMATION_OUT_TIME,
                           transition: 'easeOutQuad',
                           onComplete: Lang.bind(this, function() {
                               this.destroy();
                           })
                         });
    }
});
