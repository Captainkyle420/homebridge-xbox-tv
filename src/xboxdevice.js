"use strict";
const fs = require('fs');
const fsPromises = fs.promises;
const EventEmitter = require('events');
const RestFul = require('./restful.js');
const Mqtt = require('./mqtt.js');
const XboxWebApi = require('./webApi/xboxwebapi.js');
const XboxLocalApi = require('./localApi/xboxlocalapi.js');
const CONSTANTS = require('./constants.json');

let Accessory, Characteristic, Service, Categories, Encode, AccessoryUUID;

class XboxDevice extends EventEmitter {
    constructor(api, prefDir, device) {
        super();

        Accessory = api.platformAccessory;
        Characteristic = api.hap.Characteristic;
        Service = api.hap.Service;
        Categories = api.hap.Categories;
        Encode = api.hap.encode;
        AccessoryUUID = api.hap.uuid;

        //device configuration
        this.name = device.name;
        this.host = device.host;
        this.xboxLiveId = device.xboxLiveId;
        this.webApiControl = device.webApiControl || false;
        this.webApiPowerOnOff = this.webApiControl ? device.webApiPowerOnOff : false;
        this.webApiRcControl = this.webApiControl ? device.webApiRcControl : false;
        this.webApiVolumeControl = this.webApiControl ? device.webApiVolumeControl : false;
        this.getInputsFromDevice = this.webApiControl ? device.getInputsFromDevice : false;
        this.filterGames = device.filterGames || false;
        this.filterApps = device.filterApps || false;
        this.filterSystemApps = device.filterSystemApps || false;
        this.filterDlc = device.filterDlc || false;
        this.inputs = device.inputs || [];
        this.buttons = device.buttons || [];
        this.sensorPower = device.sensorPower || false;
        this.sensorInput = device.sensorInput || false;
        this.sensorScreenSaver = device.sensorScreenSaver || false;
        this.sensorInputs = device.sensorInputs || [];
        this.webApiClientId = device.webApiClientId;
        this.webApiClientSecret = device.webApiClientSecret;
        this.enableDebugMode = device.enableDebugMode || false;
        this.disableLogInfo = device.disableLogInfo || false;
        this.disableLogDeviceInfo = device.disableLogDeviceInfo || false;
        this.infoButtonCommand = device.infoButtonCommand || 'nexus';
        this.volumeControl = device.volumeControl || false;

        //external integration
        this.restFulConnected = false;
        this.mqttConnected = false;

        //accessory services
        this.allServices = [];
        this.sensorsInputsServices = [];
        this.buttonsServices = [];

        //add configured inputs to the default inputs and chack duplicated inputs
        const tempInputs = [...CONSTANTS.DefaultInputs, ...this.inputs];
        const inputsArr = [];
        for (const input of tempInputs) {
            const inputName = input.name;
            const inputReference = input.reference;
            const duplicatedInput = inputsArr.some(input => input.reference === inputReference);
            const push = inputName && inputReference && !duplicatedInput ? inputsArr.push(input) : false;
        }
        this.inputs = inputsArr;

        this.inputsConfigured = [];
        this.inputIdentifier = 1;

        //state variable
        this.power = false;
        this.volume = 0;
        this.mute = true;
        this.mediaState = 0;
        this.reference = '';

        //sensors variable
        this.sensorsInputsConfigured = [];
        for (const sensor of this.sensorInputs) {
            const sensorInputName = sensor.name ?? false;
            const sensorInputReference = sensor.reference ?? false;
            const sensorInputDisplayType = sensor.displayType ?? 0;
            if (sensorInputName && sensorInputReference && sensorInputDisplayType > 0) {
                sensor.serviceType = ['', Service.MotionSensor, Service.OccupancySensor, Service.ContactSensor][sensorInputDisplayType];
                sensor.characteristicType = ['', Characteristic.MotionDetected, Characteristic.OccupancyDetected, Characteristic.ContactSensorState][sensorInputDisplayType];
                sensor.state = false;
                this.sensorsInputsConfigured.push(sensor);
            } else {
                const log = sensorInputDisplayType === 0 ? false : this.emit('message', `Sensor Name: ${sensorInputName ? sensorInputName : 'Missing'}, Reference: ${sensorInputReference ? sensorInputReference : 'Missing'}.`);
            };
        }
        this.sensorsInputsConfiguredCount = this.sensorsInputsConfigured.length || 0;
        this.sensorScreenSaverState = false;
        this.sensorInputState = false;

        //buttons variable
        this.buttonsConfigured = [];
        for (const button of this.buttons) {
            const buttonName = button.name ?? false;
            const buttonCommand = button.command ?? false;
            const buttonReference = buttonCommand === 'switchAppGame' ? button.oneStoreProductId : false;
            const buttonDisplayType = button.displayType ?? 0;
            if (buttonName && buttonCommand && buttonDisplayType > 0) {
                button.serviceType = ['', Service.Outlet, Service.Switch][buttonDisplayType];
                button.state = false;
                this.buttonsConfigured.push(button);
            } else {
                const log = buttonDisplayType === 0 ? false : this.emit('message', `Button Name: ${buttonName ? buttonName : 'Missing'}, Command: ${buttonCommand ? buttonCommand : 'Missing'}, Reference: ${buttonReference ? buttonReference : 'Missing'}.`);
            };
        }
        this.buttonsConfiguredCount = this.buttonsConfigured.length || 0;

        //check files exists, if not then create it
        const postFix = this.host.split('.').join('');
        const authTokenFile = `${prefDir}/authToken_${postFix}`;
        const devInfoFile = `${prefDir}/devInfo_${postFix}`;
        const inputsFile = `${prefDir}/inputs_${postFix}`;
        this.inputsNamesFile = `${prefDir}/inputsNames_${postFix}`;
        this.inputsTargetVisibilityFile = `${prefDir}/inputsTargetVisibility_${postFix}`;

        // Create files if it doesn't exist
        try {
            const files = [
                authTokenFile,
                devInfoFile,
                inputsFile,
                this.inputsNamesFile,
                this.inputsTargetVisibilityFile,
            ];

            files.forEach((file) => {
                if (!fs.existsSync(file)) {
                    fs.writeFileSync(file, '');
                }
            });
        } catch (error) {
            this.emit('error', `prepare files error: ${error}`);
        }

        //web api client
        if (this.webApiControl) {
            this.xboxWebApi = new XboxWebApi({
                xboxLiveId: this.xboxLiveId,
                webApiClientId: this.webApiClientId,
                webApiClientSecret: this.webApiClientSecret,
                tokensFile: authTokenFile,
                inputsFile: inputsFile,
                debugLog: this.enableDebugMode
            });

            this.xboxWebApi.on('consoleStatus', (consoleType) => {
                if (this.informationService) {
                    this.informationService
                        .setCharacteristic(Characteristic.Model, consoleType)
                };

                //this.serialNumber = id;
                this.modelName = consoleType;
                //this.power = powerState;
                //this.mediaState = playbackState;
            })
                .on('powerOnError', (power) => {
                    if (this.televisionService) {
                        this.televisionService
                            .updateCharacteristic(Characteristic.Active, power)
                    };
                    this.power = power;
                })
                .on('message', (message) => {
                    this.emit('message', message);
                })
                .on('debug', (debug) => {
                    this.emit('debug', debug);
                })
                .on('error', (error) => {
                    this.emit('error', error);
                })
                .on('restFul', (path, data) => {
                    this.emit('restFul', path, data)
                })
                .on('mqtt', (topic, message) => {
                    this.emit('mqtt', topic, message)
                });
        };

        //xbox local client
        this.xboxLocalApi = new XboxLocalApi({
            host: this.host,
            xboxLiveId: this.xboxLiveId,
            tokensFile: authTokenFile,
            devInfoFile: devInfoFile,
            infoLog: this.disableLogInfo,
            debugLog: this.enableDebugMode
        });

        this.xboxLocalApi.on('deviceInfo', (firmwareRevision, locale) => {
            this.emit('message', 'Connected.');
            if (!this.disableLogDeviceInfo) {
                this.emit('devInfo', `-------- ${this.name} --------'`);
                this.emit('devInfo', `Manufacturer: Microsoft`);
                this.emit('devInfo', `Model: ${this.modelName ?? 'Xbox'}`);
                this.emit('devInfo', `Serialnr: ${this.xboxLiveId}`);
                this.emit('devInfo', `Firmware: ${firmwareRevision}`);
                this.emit('devInfo', `Locale: ${locale}`);
                this.emit('devInfo', `----------------------------------`);
            }

            if (this.informationService) {
                this.informationService
                    .setCharacteristic(Characteristic.Manufacturer, 'Microsoft')
                    .setCharacteristic(Characteristic.FirmwareRevision, firmwareRevision);
            };
        })
            .on('stateChanged', (power, volume, mute, mediaState, titleId, reference) => {
                const index = this.inputsConfigured.findIndex(input => input.reference === reference || input.titleId === titleId) ?? -1;
                const inputIdentifier = index !== -1 ? this.inputsConfigured[index].identifier : this.inputIdentifier;

                //update characteristics
                if (this.televisionService) {
                    this.televisionService
                        .updateCharacteristic(Characteristic.Active, power);
                };

                if (this.televisionService) {
                    this.televisionService
                        .updateCharacteristic(Characteristic.ActiveIdentifier, inputIdentifier);
                };

                if (this.speakerService) {
                    this.speakerService
                        .updateCharacteristic(Characteristic.Volume, volume)
                        .updateCharacteristic(Characteristic.Mute, mute);
                    if (this.volumeService) {
                        this.volumeService
                            .updateCharacteristic(Characteristic.Brightness, volume)
                            .updateCharacteristic(Characteristic.On, !mute);
                    };
                    if (this.volumeServiceFan) {
                        this.volumeServiceFan
                            .updateCharacteristic(Characteristic.RotationSpeed, volume)
                            .updateCharacteristic(Characteristic.On, !mute);
                    };
                };

                if (this.sensorPowerService) {
                    this.sensorPowerService
                        .updateCharacteristic(Characteristic.ContactSensorState, power);
                }

                if (this.sensorInputService && reference !== this.reference) {
                    for (let i = 0; i < 2; i++) {
                        const state = power ? [true, false][i] : false;
                        this.sensorInputService
                            .updateCharacteristic(Characteristic.ContactSensorState, state);
                        this.sensorInputState = state;
                    }
                }

                if (this.sensorScreenSaverService) {
                    const state = power ? (reference === 'Xbox.IdleScreen_8wekyb3d8bbwe!Xbox.IdleScreen.Application') : false;
                    this.sensorScreenSaverService
                        .updateCharacteristic(Characteristic.ContactSensorState, state);
                    this.sensorScreenSaverState = state;
                }

                if (this.sensorsInputsServices) {
                    for (let i = 0; i < this.sensorsInputsConfiguredCount; i++) {
                        const sensorInput = this.sensorsInputsConfigured[i];
                        const state = power ? sensorInput.reference === reference : false;
                        sensorInput.state = state;
                        const characteristicType = sensorInput.characteristicType;
                        this.sensorsInputsServices[i]
                            .updateCharacteristic(characteristicType, state);
                    }
                }

                //buttons
                if (this.buttonsServices) {
                    for (let i = 0; i < this.buttonsConfiguredCount; i++) {
                        const button = this.buttonsConfigured[i];
                        const state = this.power ? button.reference === reference : false;
                        button.state = state;
                        this.buttonsServices[i]
                            .updateCharacteristic(Characteristic.On, state);
                    }
                }

                this.inputIdentifier = inputIdentifier;
                this.power = power;
                this.reference = reference;
                this.volume = volume;
                this.mute = mute;
                this.mediaState = mediaState;

                if (!this.disableLogInfo) {
                    const name = index !== -1 ? this.inputsConfigured[index].name : reference;
                    const productId = index !== -1 ? this.inputsConfigured[index].oneStoreProductId : reference;
                    this.emit('message', `Power: ${power ? 'ON' : 'OFF'}`);
                    this.emit('message', `Input Name: ${name}`);
                    this.emit('message', `Reference: ${reference}`);
                    this.emit('message', `Title Id: ${titleId}`);
                    this.emit('message', `Product Id: ${productId}`);
                    this.emit('message', `Volume: ${volume}%`);
                    this.emit('message', `Mute: ${mute ? 'ON' : 'OFF'}`);
                    this.emit('message', `Media State: ${['PLAY', 'PAUSE', 'STOPPED', 'LOADING', 'INTERRUPTED'][mediaState]}`);
                };
            })
            .on('prepareAccessory', async () => {
                //RESTFul server
                const restFulEnabled = device.enableRestFul || false;
                if (restFulEnabled) {
                    this.restFul = new RestFul({
                        port: device.restFulPort || 3000,
                        debug: device.restFulDebug || false
                    });

                    this.restFul.on('connected', (message) => {
                        this.restFulConnected = true;
                        this.emit('message', message);
                    })
                        .on('error', (error) => {
                            this.emit('error', error);
                        })
                        .on('debug', (debug) => {
                            this.emit('debug', debug);
                        });
                }

                //mqtt client
                const mqttEnabled = device.enableMqtt || false;
                if (mqttEnabled) {
                    this.mqtt = new Mqtt({
                        host: device.mqttHost,
                        port: device.mqttPort || 1883,
                        clientId: device.mqttClientId || `xbox_${Math.random().toString(16).slice(3)}`,
                        prefix: `${device.mqttPrefix}/${device.name}`,
                        user: device.mqttUser,
                        passwd: device.mqttPasswd,
                        debug: device.mqttDebug || false
                    });

                    this.mqtt.on('connected', (message) => {
                        this.mqttConnected = true;
                        this.emit('message', message);
                    })
                        .on('subscribed', (message) => {
                            this.emit('message', message);
                        })
                        .on('subscribedMessage', async (key, value) => {
                            try {
                                switch (key) {
                                    case 'Power':
                                        switch (this.webApiPowerOnOff) {
                                            case true:
                                                switch (value) {
                                                    case true: //off
                                                        await this.xboxWebApi.send('Power', 'WakeUp');
                                                        break;
                                                    case false: //on
                                                        await this.xboxWebApi.send('Power', 'TurnOff');
                                                        break;
                                                }
                                                break;
                                            case false:
                                                switch (value) {
                                                    case true: //off
                                                        await this.xboxLocalApi.powerOff();
                                                        break;
                                                    case false: //on
                                                        await this.xboxLocalApi.powerOn();
                                                        break;
                                                }
                                        }
                                        break;
                                    case 'App':
                                        const payload = [{ 'oneStoreProductId': value }];
                                        await this.xboxWebApi.send('Shell', 'ActivateApplicationWithOneStoreProductId', payload);
                                        break;
                                    case 'Volume':
                                        switch (value) {
                                            case 'up': //Up
                                                await this.xboxWebApi.send('Volume', 'Up');
                                                break;
                                            case 'down': //Down
                                                await this.xboxWebApi.send('Volume', 'Down');
                                                break;
                                        }
                                        break;
                                    case 'Mute':
                                        switch (value) {
                                            case true: //Mute
                                                await this.xboxWebApi.send('Audio', 'Mute');
                                                break;
                                            case false: //Unmute;
                                                await this.xboxWebApi.send('Audio', 'Unmute');
                                                break;
                                        }
                                        break;
                                    case 'RcControl':
                                        await this.xboxWebApi.send('Shell', 'InjectKey', [{ 'keyType': value }]);
                                        break;
                                    default:
                                        this.emit('message', `MQTT Received unknown key: ${key}, value: ${value}`);
                                        break;
                                };
                            } catch (error) {
                                this.emit('error', `MQTT send error: ${error}.`);
                            };
                        })
                        .on('debug', (debug) => {
                            this.emit('debug', debug);
                        })
                        .on('error', (error) => {
                            this.emit('error', error);
                        });
                };

                try {
                    //read dev info from file
                    const savedInfo = await this.readData(devInfoFile);
                    this.savedInfo = savedInfo.toString().trim() !== '' ? JSON.parse(savedInfo) : {};
                    const debug = !this.enableDebugMode ? false : this.emit('debug', `Read saved Info: ${JSON.stringify(this.savedInfo, null, 2)}`);

                    //read inputs file
                    const savedInputs = await this.readData(inputsFile);
                    this.savedInputs = savedInputs.toString().trim() !== '' ? JSON.parse(savedInputs) : this.inputs;
                    const debug2 = !this.enableDebugMode ? false : this.emit('debug', `Read saved Inputs: ${JSON.stringify(this.savedInputs, null, 2)}`);

                    //read inputs names from file
                    const savedInputsNames = await this.readData(this.inputsNamesFile);
                    this.savedInputsNames = savedInputsNames.toString().trim() !== '' ? JSON.parse(savedInputsNames) : {};
                    const debug3 = !this.enableDebugMode ? false : this.emit('debug', `Read saved Inputs Names: ${JSON.stringify(this.savedInputsNames, null, 2)}`);

                    //read inputs visibility from file
                    const savedInputsTargetVisibility = await this.readData(this.inputsTargetVisibilityFile);
                    this.savedInputsTargetVisibility = savedInputsTargetVisibility.toString().trim() !== '' ? JSON.parse(savedInputsTargetVisibility) : {};
                    const debug4 = !this.enableDebugMode ? false : this.emit('debug', `Read saved Inputs Target Visibility: ${JSON.stringify(this.savedInputsTargetVisibility, null, 2)}`);

                    //prepare accessory
                    await new Promise(resolve => setTimeout(resolve, 2500));
                    const accessory = await this.prepareAccessory();
                    this.emit('publishAccessory', accessory)

                    //sort inputs list
                    const sortInputsDisplayOrder = this.televisionService ? await this.displayOrder() : false;
                } catch (error) {
                    this.emit('error', `prepare accessory error: ${error}`);
                };
            })
            .on('message', (message) => {
                this.emit('message', message);
            })
            .on('debug', (debug) => {
                this.emit('debug', debug);
            })
            .on('error', (error) => {
                this.emit('error', error);
            })
            .on('disconnected', (message) => {
                this.emit('message', message);
            })
            .on('restFul', (path, data) => {
                const restFul = this.restFulConnected ? this.restFul.update(path, data) : false;
            })
            .on('mqtt', (topic, message) => {
                const mqtt = this.mqttConnected ? this.mqtt.emit('publish', topic, message) : false;
            });
    }


    displayOrder() {
        return new Promise((resolve, reject) => {
            try {
                switch (this.inputsDisplayOrder) {
                    case 0:
                        this.inputsConfigured.sort((a, b) => a.identifier - b.identifier);
                        break;
                    case 1:
                        this.inputsConfigured.sort((a, b) => a.name.localeCompare(b.name));
                        break;
                    case 2:
                        this.inputsConfigured.sort((a, b) => b.name.localeCompare(a.name));
                        break;
                    case 3:
                        this.inputsConfigured.sort((a, b) => a.reference.localeCompare(b.reference));
                        break;
                    case 4:
                        this.inputsConfigured.sort((a, b) => b.reference.localeCompare(a.reference));
                        break;
                }
                const debug = !this.enableDebugMode ? false : this.emit('debug', `Inputs display order: ${JSON.stringify(this.inputsConfigured, null, 2)}`);

                const displayOrder = this.inputsConfigured.map(input => input.identifier);
                this.televisionService.setCharacteristic(Characteristic.DisplayOrder, Encode(1, displayOrder).toString('base64'));
                resolve();
            } catch (error) {
                reject(error);
            };
        });
    }

    saveData(path, data) {
        return new Promise(async (resolve, reject) => {
            try {
                await fsPromises.writeFile(path, JSON.stringify(data, null, 2));
                const debug = !this.enableDebugMode ? false : this.emit('debug', `Saved data: ${JSON.stringify(data, null, 2)}`);
                resolve();
            } catch (error) {
                reject(error);
            };
        });
    }

    readData(path) {
        return new Promise(async (resolve, reject) => {
            try {
                const data = await fsPromises.readFile(path);
                const debug = !this.enableDebugMode ? false : this.emit('debug', `Read data: ${JSON.stringify(data, null, 2)}`);
                resolve(data);
            } catch (error) {
                reject(`Read saved data error: ${error}`);
            };
        });
    }


    //Prepare accessory
    prepareAccessory() {
        return new Promise((resolve, reject) => {
            try {
                //prepare accessory
                const debug = !this.enableDebugMode ? false : this.emit('debug', `Prepare accessory`);
                const accessoryName = this.name;
                const accessoryUUID = AccessoryUUID.generate(this.xboxLiveId);
                const accessoryCategory = Categories.TV_SET_TOP_BOX;
                const accessory = new Accessory(accessoryName, accessoryUUID, accessoryCategory);

                //Pinformation service
                this.informationService = accessory.getService(Service.AccessoryInformation)
                    .setCharacteristic(Characteristic.Manufacturer, this.savedInfo.manufacturer ?? 'Microsoft')
                    .setCharacteristic(Characteristic.Model, this.savedInfo.modelName ?? 'Xbox')
                    .setCharacteristic(Characteristic.SerialNumber, this.savedInfo.serialNumber ?? this.xboxLiveId)
                    .setCharacteristic(Characteristic.FirmwareRevision, this.savedInfo.firmwareRevision ?? 'Firmware Revision');
                this.allServices.push(this.informationService);

                //Prepare television service
                const debug1 = !this.enableDebugMode ? false : this.emit('debug', `Prepare television service`);
                this.televisionService = accessory.addService(Service.Television, `${accessoryName} Television`, 'Television');
                this.televisionService.setCharacteristic(Characteristic.ConfiguredName, accessoryName);
                this.televisionService.setCharacteristic(Characteristic.SleepDiscoveryMode, 1);

                this.televisionService.getCharacteristic(Characteristic.Active)
                    .onGet(async () => {
                        const state = this.power;
                        return state;
                    })
                    .onSet(async (state) => {
                        if (this.power == state) {
                            return;
                        }

                        try {
                            let channelName;
                            let command;

                            switch (this.webApiPowerOnOff) {
                                case true:
                                    switch (this.power) {
                                        case true: //off
                                            channelName = 'Power';
                                            command = 'TurnOff';
                                            break;
                                        case false: //on
                                            channelName = 'Power';
                                            command = 'WakeUp';
                                            break;
                                    }

                                    await this.xboxWebApi.send(channelName, command);
                                    break;
                                case false:
                                    switch (this.power) {
                                        case true: //off
                                            await this.xboxLocalApi.powerOff();
                                            break;
                                        case false: //on
                                            await this.xboxLocalApi.powerOn();
                                            break;
                                    }
                            }

                            const logInfo = this.disableLogInfo ? false : this.emit('message', `set Power: ${state ? 'ON' : 'OFF'}`);
                        } catch (error) {
                            this.emit('error', `set Power, error: ${error}`);
                        };
                    });

                this.televisionService.getCharacteristic(Characteristic.ActiveIdentifier)
                    .onGet(async () => {
                        const inputIdentifier = this.inputIdentifier;
                        return inputIdentifier;
                    })
                    .onSet(async (activeIdentifier) => {
                        try {
                            const index = this.inputsConfigured.findIndex(input => input.identifier === activeIdentifier);
                            const inputOneStoreProductId = this.inputsConfigured[index].oneStoreProductId;
                            const inputReference = this.inputsConfigured[index].reference;
                            const inputName = this.inputsConfigured[index].name;

                            let channelName;
                            let command;
                            let payload;
                            switch (this.power) {
                                case false:
                                    await new Promise(resolve => setTimeout(resolve, 4000));
                                    const tryAgain = this.power ? this.televisionService.setCharacteristic(Characteristic.ActiveIdentifier, activeIdentifier) : false;
                                    break;
                                case true:
                                    switch (inputOneStoreProductId) {
                                        case 'Dashboard': case 'Settings': case 'SettingsTv': case 'Accessory': case 'Screensaver': case 'NetworkTroubleshooter': case 'MicrosoftStore':
                                            channelName = 'Shell';
                                            command = 'GoHome';
                                            break;
                                        case 'Television':
                                            channelName = 'TV';
                                            command = 'ShowGuide';
                                            break;
                                        case 'XboxGuide':
                                            channelName = 'Shell';
                                            command = 'ShowGuideTab';
                                            payload = [{ 'tabName': 'Guide' }];
                                            break;
                                        default:
                                            channelName = 'Shell';
                                            command = 'ActivateApplicationWithOneStoreProductId';
                                            payload = [{ 'oneStoreProductId': inputOneStoreProductId }];
                                            break;
                                    }

                                    await this.xboxWebApi.send(channelName, command, payload);
                                    const logInfo = this.disableLogInfo ? false : this.emit('message', `set Input: ${inputName}, Reference: ${inputReference}, Product Id: ${inputOneStoreProductId}`);
                                    break;
                            }
                        } catch (error) {
                            this.emit('error', `set Input error: ${JSON.stringify(error, null, 2)}`);
                        };
                    });

                this.televisionService.getCharacteristic(Characteristic.RemoteKey)
                    .onSet(async (remoteKey) => {
                        try {
                            let channelName;
                            let command;

                            switch (remoteKey) {
                                case 0: //REWIND
                                    channelName = 'Shell';
                                    command = 'rewind';
                                    break;
                                case 1: //FAST_FORWARD
                                    channelName = 'Shell';
                                    command = 'fastForward';
                                    break;
                                case 2: //NEXT_TRACK
                                    channelName = 'Shell';
                                    command = 'nextTrack';
                                    break;
                                case 3: //PREVIOUS_TRACK
                                    channelName = 'Shell';
                                    command = 'previousTrack';
                                    break;
                                case 4: //ARROW_UP
                                    channelName = 'Shell';
                                    command = 'up';
                                    break;
                                case 5: //ARROW_DOWN
                                    channelName = 'Shell';
                                    command = 'down';
                                    break;
                                case 6: //ARROW_LEFT
                                    channelName = 'Shell';
                                    command = 'left';
                                    break;
                                case 7: //ARROW_RIGHT
                                    channelName = 'Shell';
                                    command = 'right';
                                    break;
                                case 8: //SELECT
                                    channelName = 'Shell';
                                    command = 'a';
                                    break;
                                case 9: //BACK
                                    channelName = 'Shell';
                                    command = 'b';
                                    break;
                                case 10: //EXIT
                                    channelName = 'Shell';
                                    command = 'nexus';
                                    break;
                                case 11: //PLAY_PAUSE
                                    channelName = 'Shell';
                                    command = 'playPause';
                                    break;
                                case 15: //INFORMATION
                                    channelName = 'Shell';
                                    command = this.infoButtonCommand;
                                    break;
                            };

                            await this.xboxWebApi.send(channelName, 'InjectKey', [{ 'keyType': command }]);
                            const logInfo = this.disableLogInfo ? false : this.emit('message', `Remote Key: ${command}`);
                        } catch (error) {
                            this.emit('error', `set Remote Key error: ${JSON.stringify(error, null, 2)}`);
                        };
                    });

                this.televisionService.getCharacteristic(Characteristic.CurrentMediaState)
                    .onGet(async () => {
                        //apple, 0 - PLAY, 1 - PAUSE, 2 - STOP, 3 - LOADING, 4 - INTERRUPTED
                        //xbox, 0 - STOP, 1 - PLAY, 2 - PAUSE
                        const value = [2, 0, 1, 3, 4][this.mediaState];
                        return value;
                    });

                this.televisionService.getCharacteristic(Characteristic.TargetMediaState)
                    .onGet(async () => {
                        //0 - PLAY, 1 - PAUSE, 2 - STOP
                        const value = [2, 0, 1, 3, 4][this.mediaState];
                        return value;
                    })
                    .onSet(async (value) => {
                        try {
                            const newMediaState = value;
                            const setMediaState = this.power ? false : false;
                            const logInfo = this.disableLogInfo ? false : this.emit('message', `set Target Media: ${['PLAY', 'PAUSE', 'STOP', 'LOADING', 'INTERRUPTED'][value]}`);
                        } catch (error) {
                            this.emit('error', `set Target Media error: ${error}`);
                        };
                    });

                this.televisionService.getCharacteristic(Characteristic.PowerModeSelection)
                    .onSet(async (powerModeSelection) => {
                        try {
                            let channelName;
                            let command;
                            switch (powerModeSelection) {
                                case 0: //SHOW
                                    channelName = 'Shell';
                                    command = 'nexus';
                                    break;
                                case 1: //HIDE
                                    channelName = 'Shell';
                                    command = 'b';
                                    break;
                            };

                            await this.xboxWebApi.send(channelName, 'InjectKey', [{ 'keyType': command }]);
                            const logInfo = this.disableLogInfo ? false : this.emit('message', `set Power Mode Selection: ${powerModeSelection === 0 ? 'SHOW' : 'HIDE'}`);
                        } catch (error) {
                            this.emit('error', `set Power Mode Selection error: ${error}`);
                        };
                    });
                this.allServices.push(this.televisionService);

                //Prepare speaker service
                const debug2 = !this.enableDebugMode ? false : this.emit('debug', `Prepare speaker service`);
                this.speakerService = accessory.addService(Service.TelevisionSpeaker, `${accessoryName} Speaker`, 'Speaker');
                this.speakerService.getCharacteristic(Characteristic.Active)
                    .onGet(async () => {
                        const state = this.power;
                        return state;
                    })
                    .onSet(async (state) => {
                    });

                this.speakerService.getCharacteristic(Characteristic.VolumeControlType)
                    .onGet(async () => {
                        const state = 3; //none, relative, relative with current, absolute
                        return state;
                    });

                this.speakerService.getCharacteristic(Characteristic.VolumeSelector)
                    .onSet(async (volumeSelector) => {
                        try {
                            let channelName;
                            let command;
                            switch (volumeSelector) {
                                case 0: //Up
                                    channelName = 'Volume';
                                    command = 'Up';
                                    break;
                                case 1: //Down
                                    channelName = 'Volume';
                                    command = 'Down';
                                    break;
                            }

                            await this.xboxWebApi.send(channelName, command);
                            const logInfo = this.disableLogInfo ? false : this.emit('message', `set Volume Selector: ${volumeSelector ? 'Down' : 'UP'}`);
                        } catch (error) {
                            this.emit('error', `set Volume Selector error: ${error}`);
                        };
                    })

                this.speakerService.getCharacteristic(Characteristic.Volume)
                    .onGet(async () => {
                        const volume = this.volume;
                        return volume;
                    })
                    .onSet(async (value) => {
                        volume = (value <= 0 || value >= 100) ? this.volume : value;
                        const logInfo = this.disableLogInfo ? false : this.emit('message', `set Volume: ${volume}`);
                    });

                this.speakerService.getCharacteristic(Characteristic.Mute)
                    .onGet(async () => {
                        const state = this.mute;
                        return state;
                    })
                    .onSet(async (state) => {
                        try {
                            let channelName;
                            let command;
                            switch (volumeSelector) {
                                case 0: //Mute
                                    channelName = 'Audio';
                                    command = 'Mute';
                                    break;
                                case 1: //Unmute
                                    channelName = 'Audio';
                                    command = 'Unmute';
                                    break;
                            }

                            await this.xboxWebApi.send(channelName, command);
                            const logInfo = this.disableLogInfo ? false : this.emit('message', `set Mute: ${state ? 'ON' : 'OFF'}`);
                        } catch (error) {
                            this.emit('error', `set Mute error: ${error}`);
                        };
                    });
                this.allServices.push(this.speakerService);

                //prepare inputs service
                const debug3 = !this.enableDebugMode ? false : this.emit('debug', `Prepare inputs service`);

                //filter unnecessary inputs
                const filteredInputsArr = [];
                for (const input of this.savedInputs) {
                    const contentType = input.contentType;
                    const filterGames = this.filterGames ? (contentType === 'Game') : false;
                    const filterApps = this.filterApps ? (contentType === 'App') : false;
                    const filterSystemApps = this.filterSystemApps ? (contentType === 'systemApp') : false;
                    const filterDlc = this.filterDlc ? (contentType === 'Dlc') : false;
                    const push = this.getInputsFromDevice ? ((!filterGames && !filterApps && !filterSystemApps && !filterDlc) ? filteredInputsArr.push(input) : false) : filteredInputsArr.push(input);
                }

                //check possible inputs count (max 85)
                const inputs = filteredInputsArr;
                const inputsCount = inputs.length;
                const possibleInputsCount = 85 - this.allServices.length;
                const maxInputsCount = inputsCount >= possibleInputsCount ? possibleInputsCount : inputsCount;
                for (let i = 0; i < maxInputsCount; i++) {
                    //input
                    const input = inputs[i];

                    //get identifier
                    const inputIdentifier = i + 1;

                    //get input reference
                    const inputReference = input.reference || input.titleId;
                    input.reference = inputReference;

                    //get input name
                    const name = input.name ?? `Input ${inputIdentifier}`;
                    const savedInputsNames = this.savedInputsNames[inputReference] ?? false;
                    const inputName = !savedInputsNames ? name : savedInputsNames;
                    input.name = inputName;

                    //get input type
                    const inputSourceType = 0;

                    //get input configured
                    const isConfigured = 1;

                    //get visibility
                    const currentVisibility = this.savedInputsTargetVisibility[inputReference] ?? 0;
                    input.visibility = currentVisibility;

                    //add identifier to the input
                    input.identifier = inputIdentifier;

                    //input service
                    const inputService = accessory.addService(Service.InputSource, inputName, `Input ${inputIdentifier}`);
                    inputService
                        .setCharacteristic(Characteristic.Identifier, inputIdentifier)
                        .setCharacteristic(Characteristic.Name, inputName.substring(0, 64))
                        .setCharacteristic(Characteristic.InputSourceType, inputSourceType)
                        .setCharacteristic(Characteristic.IsConfigured, isConfigured)
                        .setCharacteristic(Characteristic.CurrentVisibilityState, currentVisibility)

                    inputService.getCharacteristic(Characteristic.ConfiguredName)
                        .onGet(async () => {
                            return inputName;
                        })
                        .onSet(async (value) => {
                            if (value === this.savedInputsNames[inputReference]) {
                                return;
                            }

                            try {
                                this.savedInputsNames[inputReference] = value;
                                await this.saveData(this.inputsNamesFile, this.savedInputsNames);
                                const debug = !this.enableDebugMode ? false : this.emit('debug', `Saved Input Name: ${value}, Reference: ${nameIdentifier}.`);

                                //sort inputs
                                const index = this.inputsConfigured.findIndex(input => input.reference === inputReference);
                                this.inputsConfigured[index].name = value;
                                await this.displayOrder();
                            } catch (error) {
                                this.emit('error', `save Input Name error: ${error}`);
                            }
                        });

                    inputService.getCharacteristic(Characteristic.TargetVisibilityState)
                        .onGet(async () => {
                            return currentVisibility;
                        })
                        .onSet(async (state) => {
                            if (state === this.savedInputsTargetVisibility[inputReference]) {
                                return;
                            }

                            try {
                                this.savedInputsTargetVisibility[inputReference] = state;
                                await this.saveData(this.inputsTargetVisibilityFile, this.savedInputsTargetVisibility);
                                const debug = !this.enableDebugMode ? false : this.emit('debug', `Saved Input: ${inputName} Target Visibility: ${state ? 'HIDEN' : 'SHOWN'}`);
                            } catch (error) {
                                this.emit('error', `save Target Visibility error: ${error}`);
                            }
                        });
                    this.inputsConfigured.push(input);
                    this.televisionService.addLinkedService(inputService);
                    this.allServices.push(inputService);
                }

                //Prepare volume service
                if (this.volumeControl) {
                    const debug = !this.enableDebugMode ? false : this.emit('debug', `Prepare volume service`);
                    if (this.volumeControl === 1) {
                        this.volumeService = accessory.addService(Service.Lightbulb, `${accessoryName} Volume`, 'Volume');
                        this.volumeService.addOptionalCharacteristic(Characteristic.ConfiguredName);
                        this.volumeService.setCharacteristic(Characteristic.ConfiguredName, `${accessoryName} Volume`);
                        this.volumeService.getCharacteristic(Characteristic.Brightness)
                            .onGet(async () => {
                                const volume = this.volume;
                                return volume;
                            })
                            .onSet(async (volume) => {
                                this.speakerService.setCharacteristic(Characteristic.Volume, volume);
                            });
                        this.volumeService.getCharacteristic(Characteristic.On)
                            .onGet(async () => {
                                const state = !this.mute;
                                return state;
                            })
                            .onSet(async (state) => {
                                this.speakerService.setCharacteristic(Characteristic.Mute, !state);
                            });

                        this.allServices.push(this.volumeService);
                    }

                    if (this.volumeControl === 2) {
                        this.volumeServiceFan = accessory.addService(Service.Fan, `${accessoryName} Volume`, 'Volume');
                        this.volumeServiceFan.addOptionalCharacteristic(Characteristic.ConfiguredName);
                        this.volumeServiceFan.setCharacteristic(Characteristic.ConfiguredName, `${accessoryName} Volume`);
                        this.volumeServiceFan.getCharacteristic(Characteristic.RotationSpeed)
                            .onGet(async () => {
                                const volume = this.volume;
                                return volume;
                            })
                            .onSet(async (volume) => {
                                this.speakerService.setCharacteristic(Characteristic.Volume, volume);
                            });
                        this.volumeServiceFan.getCharacteristic(Characteristic.On)
                            .onGet(async () => {
                                const state = !this.mute;
                                return state;
                            })
                            .onSet(async (state) => {
                                this.speakerService.setCharacteristic(Characteristic.Mute, !state);
                            });
                        this.allServices.push(this.volumeServiceFan);
                    }
                }

                //prepare sensor service
                if (this.sensorPower) {
                    const debug = !this.enableDebugMode ? false : this.emit('debug', `Prepare power sensor service`);
                    this.sensorPowerService = accessory.addService(Service.ContactSensor, `${accessoryName} Power Sensor`, `Power Sensor`);
                    this.sensorPowerService.addOptionalCharacteristic(Characteristic.ConfiguredName);
                    this.sensorPowerService.setCharacteristic(Characteristic.ConfiguredName, `${accessoryName} Power Sensor`);
                    this.sensorPowerService.getCharacteristic(Characteristic.ContactSensorState)
                        .onGet(async () => {
                            const state = this.power;
                            return state;
                        });
                    this.allServices.push(this.sensorPowerService);
                };

                if (this.sensorInput) {
                    const debug = !this.enableDebugMode ? false : this.emit('debug', `Prepare input sensor service`);
                    this.sensorInputService = accessory.addService(Service.ContactSensor, `${accessoryName} Input Sensor`, `Input Sensor`);
                    this.sensorInputService.addOptionalCharacteristic(Characteristic.ConfiguredName);
                    this.sensorInputService.setCharacteristic(Characteristic.ConfiguredName, `${accessoryName} Input Sensor`);
                    this.sensorInputService.getCharacteristic(Characteristic.ContactSensorState)
                        .onGet(async () => {
                            const state = this.power ? this.sensorInputState : false;
                            return state;
                        });
                    this.allServices.push(this.sensorInputService);
                };

                if (this.sensorScreenSaver) {
                    const debug = !this.enableDebugMode ? false : this.emit('debug', `Prepare screen saver sensor service`);
                    this.sensorScreenSaverService = accessory.addService(Service.ContactSensor, `${accessoryName} Screen Saver Sensor`, `Screen Saver Sensor`);
                    this.sensorScreenSaverService.addOptionalCharacteristic(Characteristic.ConfiguredName);
                    this.sensorScreenSaverService.setCharacteristic(Characteristic.ConfiguredName, `${accessoryName} Screen Saver Sensor`);
                    this.sensorScreenSaverService.getCharacteristic(Characteristic.ContactSensorState)
                        .onGet(async () => {
                            const state = this.power ? this.sensorScreenSaverState : false;
                            return state;
                        });
                    this.allServices.push(this.sensorScreenSaverService);
                };

                //prepare sonsor service
                const possibleSensorInputsCount = 99 - this.allServices.length;
                const maxSensorInputsCount = this.sensorsInputsConfiguredCount >= possibleSensorInputsCount ? possibleSensorInputsCount : this.sensorsInputsConfiguredCount;
                if (maxSensorInputsCount > 0) {
                    const debug = !this.enableDebugMode ? false : this.emit('debug', `Prepare inputs sensors services`);
                    for (let i = 0; i < maxSensorInputsCount; i++) {
                        //get sensor
                        const sensorInput = this.sensorsInputsConfigured[i];

                        //get sensor name		
                        const sensorInputName = sensorInput.name;

                        //get sensor name prefix
                        const namePrefix = sensorInput.namePrefix || false;

                        //get service type
                        const serviceType = sensorInput.serviceType;

                        //get service type
                        const characteristicType = sensorInput.characteristicType;

                        const serviceName = namePrefix ? `${accessoryName} ${sensorInputName}` : sensorInputName;
                        const sensorInputService = new serviceType(serviceName, `Sensor ${i}`);
                        sensorInputService.addOptionalCharacteristic(Characteristic.ConfiguredName);
                        sensorInputService.setCharacteristic(Characteristic.ConfiguredName, serviceName);
                        sensorInputService.getCharacteristic(characteristicType)
                            .onGet(async () => {
                                const state = sensorInput.state
                                return state;
                            });
                        this.sensorsInputsServices.push(sensorInputService);
                        this.allServices.push(sensorInputService);
                        accessory.addService(sensorInputService);
                    }
                }


                //Prepare buttons services
                const possibleButtonsCount = 99 - this.allServices.length;
                const maxButtonsCount = this.buttonsConfiguredCount >= possibleButtonsCount ? possibleButtonsCount : this.buttonsConfiguredCount;
                if (maxButtonsCount > 0) {
                    const debug = !this.enableDebugMode ? false : this.emit('debug', `Prepare buttons services`);
                    for (let i = 0; i < maxButtonsCount; i++) {
                        //get button
                        const button = this.buttonsConfigured[i];

                        //get button name
                        const buttonName = button.name;

                        //get button command
                        const buttonCommand = button.command;

                        //get button mode
                        let mode;
                        if (buttonCommand in CONSTANTS.LocalApi.Channels.System.Media.Commands) {
                            mode = 0;
                        } else if (buttonCommand in CONSTANTS.LocalApi.Channels.System.Input.Commands) {
                            mode = 1;
                        } else if (buttonCommand in CONSTANTS.LocalApi.Channels.System.TvRemote.Commands) {
                            mode = 2;
                        } else if (buttonCommand === 'recordGameDvr') {
                            mode = 3;
                        } else if (buttonCommand === 'reboot') {
                            mode = 4;
                        } else if (buttonCommand === 'switchAppGame') {
                            mode = 5;
                        };
                        const buttonMode = mode;

                        //get button inputOneStoreProductId
                        const buttonOneStoreProductId = button.oneStoreProductId;

                        //get button name prefix
                        const namePrefix = button.namePrefix ?? false;

                        //get service type
                        const serviceType = button.serviceType;

                        const serviceName = namePrefix ? `${accessoryName} ${buttonName}` : buttonName;
                        const buttonService = new serviceType(serviceName, `Button ${i}`);
                        buttonService.addOptionalCharacteristic(Characteristic.ConfiguredName);
                        buttonService.setCharacteristic(Characteristic.ConfiguredName, serviceName);
                        buttonService.getCharacteristic(Characteristic.On)
                            .onGet(async () => {
                                const state = button.state;
                                return state;
                            })
                            .onSet(async (state) => {
                                try {
                                    switch (buttonMode) {
                                        case 0: case 1: case 2:
                                            const send = state ? await this.xboxWebApi.send('Shell', 'InjectKey', [{ 'keyType': buttonCommand }]) : false;
                                            break;
                                        case 3:
                                            const send1 = this.power && state ? await this.xboxLocalApi.recordGameDvr() : false;
                                            break;
                                        case 4:
                                            const send2 = this.power && state ? await this.xboxWebApi.send('Power', 'Reboot') : false;
                                            break;
                                        case 5:
                                            switch (buttonOneStoreProductId) {
                                                case 'Dashboard': case 'Settings': case 'SettingsTv': case 'Accessory': case 'Screensaver': case 'NetworkTroubleshooter': case 'MicrosoftStore':
                                                    const send3 = this.power && state ? await this.xboxWebApi.send('Shell', 'GoHome') : false;
                                                    break;
                                                case 'Television':
                                                    const send4 = this.power && state ? await this.xboxWebApi.send('TV', 'ShowGuide') : false;
                                                    break;
                                                case 'XboxGuide':
                                                    const send5 = this.power && state ? await this.xboxWebApi.send('Shell', 'ShowGuideTab', [{ 'tabName': 'Guide' }]) : false;
                                                    break;
                                                case 'Not set': case 'Web api disabled':
                                                    this.emit('message', `trying to launch App/Game with one store product id: ${buttonOneStoreProductId}.`);
                                                    break;
                                                default:
                                                    const send6 = this.power && state ? await this.xboxWebApi.send('Shell', 'ActivateApplicationWithOneStoreProductId', [{ 'oneStoreProductId': buttonOneStoreProductId }]) : false;
                                                    break;
                                            }
                                            break;
                                    }
                                } catch (error) {
                                    this.emit('error', `set Button error: ${error}`);
                                    button.state = false;
                                };
                            });
                        this.buttonsServices.push(buttonService);
                        this.allServices.push(buttonService);
                        accessory.addService(buttonService);
                    }
                }
                resolve(accessory);
            } catch (error) {
                reject(error)
            };
        });
    }
};
module.exports = XboxDevice;
