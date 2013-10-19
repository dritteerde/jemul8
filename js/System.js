/**
 * jemul8 - JavaScript x86 Emulator
 * http://jemul8.com/
 *
 * Copyright 2013 jemul8.com (http://github.com/asmblah/jemul8)
 * Released under the MIT license
 * http://jemul8.com/MIT-LICENSE.txt
 */

/*global define */
define([
    "js/plugins",
    "require",
    "js/util",
    "js/EventEmitter",
    "js/Exception",
    "js/Pin",
    "js/Promise",
    "js/Timer"
], function (
    plugins,
    require,
    util,
    EventEmitter,
    Exception,
    Pin,
    Promise,
    Timer
) {
    "use strict";

    var EQUIPMENT_CHANGE = "equipment change",
        hasOwn = {}.hasOwnProperty;

    function System(clock, io, memory) {
        EventEmitter.call(this);

        this.clock = clock;
        this.floppyDriveType = 0;

        // (H)old (R)e(Q)uest
        this.hrq = new Pin("HRQ");

        this.cpu = null;
        this.dma = null;
        this.inited = false;
        this.io = io;
        this.irqHandlers = {};
        this.memory = memory;
        this.numberOfSupportedFloppies = 0;
        this.pic = null;
        this.pluginsToLoad = [];
        this.running = false;
        this.timers = [];
    }

    util.inherit(System).from(EventEmitter);

    util.extend(System.prototype, {
        acknowledgeInterrupt: function () {
            return this.pic.acknowledgeInterrupt();
        },

        createTimer: function () {
            var system = this,
                timer = new Timer(system);

            system.timers.push(timer);

            return timer;
        },

        debug: function (message) {
            util.debug(message);
        },

        getA20Mask: function () {
            return 0xFFFFFFFF;
        },

        getClock: function () {
            return this.clock;
        },

        getCPURegisters: function () {
            return this.cpu.getRegisters();
        },

        getFloppyDriveType: function () {
            return this.floppyDriveType;
        },

        getMicrosecondsNow: function () {
            return this.clock.getMicrosecondsNow();
        },

        getNumberOfSupportedFloppies: function () {
            return this.numberOfSupportedFloppies;
        },

        getTicksNow: function () {
            return this.clock.getTicksNow();
        },

        handleAsynchronousEvents: function () {
            var system = this,
                ticksNow = system.getTicksNow();

            util.each(system.timers, function (timer) {
                timer.tick(ticksNow);
            });

            system.emit("async events");
        },

        init: function () {
            var system = this,
                promise = new Promise();

            function loadPlugins() {
                var loadsRemaining = 0,
                    promise = new Promise();

                function checkLoaded() {
                    if (loadsRemaining === 0) {
                        promise.resolve();
                    }
                }

                function loadPlugin(plugin) {
                    util.each(plugin.setupIODevices(), function (fn, ioDeviceIdentifier) {
                        var ioDevice = system.io.getRegisteredDevice(ioDeviceIdentifier),
                            result;

                        if (!ioDevice) {
                            throw new Exception("System.init() :: No I/O device registered with identifier '" + ioDeviceIdentifier + "'");
                        }

                        markLoading();

                        result = fn(ioDevice.getPluginData());

                        if (result instanceof Promise) {
                            result.done(function () {
                                markLoaded();
                            }).fail(function (exception) {
                                promise.reject(exception);
                            });
                        } else {
                            markLoaded();
                        }
                    });

                    markLoaded();
                }

                function markLoading() {
                    loadsRemaining++;
                }

                function markLoaded() {
                    loadsRemaining--;

                    checkLoaded();
                }

                util.each(system.pluginsToLoad, function (identifier) {
                    markLoading();

                    if (util.isString(identifier)) {
                        require(["./Plugin/" + plugins[identifier]], function (Plugin) {
                            var plugin = new Plugin();

                            loadPlugin(plugin);
                        });
                    } else {
                        loadPlugin(identifier);
                    }
                });

                checkLoaded();

                return promise;
            }

            loadPlugins().done(function () {
                system.cpu.on("interrupt", function (vector) {
                    system.emit("interrupt", vector);
                });

                system.io.on("io read", function (port, length) {
                    system.emit("io read", port, length);
                });

                system.io.on("io write", function (port, value, length) {
                    system.emit("io write", port, value, length);
                });

                system.cpu.init().done(function () {
                    system.io.init().done(function () {
                        system.cpu.reset();
                        system.io.reset();

                        system.inited = true;
                        promise.resolve();
                    }).fail(function (exception) {
                        promise.reject(exception);
                    });
                }).fail(function (exception) {
                    promise.reject(exception);
                });
            }).fail(function (exception) {
                promise.reject(exception);
            });

            return promise;
        },

        isHRQHigh: function () {
            return this.hrq.isHigh();
        },

        loadPlugin: function (identifier) {
            var system = this;

            if (util.isString(identifier)) {
                if (!hasOwn.call(plugins, identifier)) {
                    throw new Exception("Emulator.loadPlugin() :: Unrecognised standard plugin identifier '" + identifier + "'");
                }
            }

            system.pluginsToLoad.push(identifier);
        },

        loadROM: function (buffer, address, type) {
            var system = this;

            // Convert to legacy type
            type = {
                "cmos": 0
            }[type];

            system.legacyJemul8.machine.mem.loadROM(buffer, address, type);

            return system;
        },

        lowerHRQ: function () {
            this.hrq.lower();
        },

        lowerINTR: function () {
            this.cpu.lowerINTR();
        },

        lowerIRQ: function (irq) {
            var system = this;

            system.emit("irq low", irq);

            system.pic.lowerIRQ(irq);
        },

        observeEquipment: function (callback) {
            var system = this;

            system.on(EQUIPMENT_CHANGE, callback);
            callback.call(system);

            return system;
        },

        pause: function () {
            var system = this;

            system.running = false;
            system.cpu.halt();
            system.emit("pause");

            return system;
        },

        raiseHLDA: function () {
            this.dma.raiseHLDA();
        },

        raiseINTR: function () {
            this.cpu.raiseINTR();
        },

        raiseHRQ: function () {
            this.hrq.raise();
        },

        raiseIRQ: function (irq) {
            var system = this;

            system.emit("irq high", irq);

            system.pic.raiseIRQ(irq);
        },

        registerIRQ: function (irq, handler) {
            var irqHandlers = this.irqHandlers;

            if (irq < 0 || irq > 0xF) {
                throw new Exception("IO.registerIRQ() :: Invalid IRQ number " + irq + " - must be between 0-F inclusive");
            }

            if (irqHandlers[irq]) {
                throw new Exception("IO.registerIRQ() :: IRQ conflict for '" + handler + "' (already in use by '" + irqHandlers[irq] + "')");
            }

            irqHandlers[irq] = handler;
        },

        // Hardware reset
        reset: function () {
            var system = this;

            system.setEnableA20(false);

            // Always reset CPU
            system.cpu.reset();

            system.io.reset();
        },

        run: function () {
            var system = this;

            if (!system.inited) {
                throw new Exception("System.run() :: Not yet initialized");
            }

            system.running = true;

            return system.cpu.run();
        },

        setCPU: function (cpu) {
            this.cpu = cpu;
        },

        setDMA: function (dma) {
            this.dma = dma;
        },

        setFloppyDriveType: function (floppyDriveType) {
            var system = this;

            system.floppyDriveType = floppyDriveType;
            system.emit(EQUIPMENT_CHANGE);

            return system;
        },

        setNumberOfSupportedFloppies: function (numberOfSupportedFloppies) {
            var system = this;

            system.numberOfSupportedFloppies = numberOfSupportedFloppies;
            system.emit(EQUIPMENT_CHANGE);

            return system;
        },

        setPIC: function (pic) {
            this.pic = pic;
        },

        write: function (options) {
            var data,
                offset,
                port,
                size,
                system = this,
                to;

            options = options || {};

            if (!hasOwn.call(options, "data")) {
                throw new Exception("System.write() :: 'data' not specified");
            }

            if (!hasOwn.call(options, "to") && !hasOwn.call(options, "port")) {
                throw new Exception("System.write() :: Either 'to' or 'port' must be specified");
            }

            data = options.data;

            // Writing to memory
            if (hasOwn.call(options, "to")) {
                to = options.to;
                size = data.length;

                if (options.data.byteLength) {
                    system.memory.writePhysicalBlock(to, data);
                } else if (util.isArray(data)) {
                    for (offset = 0; offset < size; offset += 1) {
                        system.memory.writePhysical(to + offset, data[offset], 1);
                    }
                }
            // Writing to I/O address space
            } else {
                port = options.port;
                size = options.length;

                system.io.write(port, data, size);
            }
        }
    });

    return System;
});
