'use strict';
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const xboxWebApi = require('xbox-webapi');
const XboxLocalApi = require('./src/xboxlocalapi.js');
const Mqtt = require('./src/mqtt.js');

const PLUGIN_NAME = 'homebridge-xbox-tv';
const PLATFORM_NAME = 'XboxTv';
const CONSTANS = require('./src/constans.json');

let Accessory, Characteristic, Service, Categories, UUID;

module.exports = (api) => {
	Accessory = api.platformAccessory;
	Characteristic = api.hap.Characteristic;
	Service = api.hap.Service;
	Categories = api.hap.Categories;
	UUID = api.hap.uuid;
	api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, XBOXPLATFORM, true);
};

class XBOXPLATFORM {
	constructor(log, config, api) {
		// only load if configured
		if (!config || !Array.isArray(config.devices)) {
			log(`No configuration found for ${PLUGIN_NAME}`);
			return;
		}
		this.log = log;
		this.api = api;
		this.accessories = [];
		const devices = config.devices;

		this.api.on('didFinishLaunching', () => {
			this.log.debug('didFinishLaunching');
			for (const device of devices) {
				if (!device.name || !device.host || !device.xboxLiveId) {
					this.log.warn('Device Name, Host or Xbox Live ID Missing');
					return;
				}
				new XBOXDEVICE(this.log, this.api, device);
			}
		});
	}

	configureAccessory(accessory) {
		this.log.debug('configureAccessory');
		this.accessories.push(accessory);
	}

	removeAccessory(accessory) {
		this.log.debug('removeAccessory');
		this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
	}
}

class XBOXDEVICE {
	constructor(log, api, config) {
		this.log = log;
		this.api = api;
		this.config = config;

		//device configuration
		this.name = config.name;
		this.host = config.host;
		this.xboxLiveId = config.xboxLiveId;
		this.webApiControl = config.webApiControl || false;
		this.clientId = config.clientId || '5e5ead27-ed60-482d-b3fc-702b28a97404';
		this.clientSecret = config.clientSecret || false;
		this.userToken = config.userToken;
		this.userHash = config.userHash;
		this.xboxWebApiToken = config.xboxWebApiToken || '';
		this.disableLogInfo = config.disableLogInfo || false;
		this.disableLogDeviceInfo = config.disableLogDeviceInfo || false;
		this.enableDebugMode = config.enableDebugMode || false;
		this.volumeControl = config.volumeControl || 0;
		this.infoButtonCommand = config.infoButtonCommand || 'nexus';
		this.getInputsFromDevice = config.getInputsFromDevice || false;
		this.filterGames = config.filterGames || false;
		this.filterApps = config.filterApps || false;
		this.filterSystemApps = config.filterSystemApps || false;
		this.filterDlc = config.filterDlc || false;
		this.inputs = config.inputs || [];
		this.buttons = config.buttons || [];
		this.sensorPower = config.sensorPower || false;
		this.sensorInput = config.sensorInput || false;
		this.sensorScreenSaver = config.sensorScreenSaver || false;
		this.sensorInputs = config.sensorInputs || [];
		this.mqttEnabled = config.enableMqtt || false;
		this.mqttHost = config.mqttHost;
		this.mqttPort = config.mqttPort || 1883;
		this.mqttPrefix = config.mqttPrefix;
		this.mqttAuth = config.mqttAuth || false;
		this.mqttUser = config.mqttUser;
		this.mqttPasswd = config.mqttPasswd;
		this.mqttDebug = config.mqttDebug || false;

		//add configured inputs to the default inputs
		this.inputs = [...CONSTANS.DefaultInputs, ...this.inputs];

		//device
		this.manufacturer = 'Microsoft';
		this.modelName = 'Model Name';
		this.serialNumber = this.xboxLiveId;
		this.firmwareRevision = 'Firmware Revision';

		//setup variables
		this.webApiEnabled = false;
		this.firstRun = true;

		this.inputsArr = [];
		this.inputsReference = [];
		this.inputsOneStoreProductId = [];
		this.inputsName = [];
		this.inputsTitleId = [];
		this.inputsType = [];
		this.inputsSensorsReference = [];
		this.inputsSensorsDisplayType = [];

		this.power = false;
		this.volume = 0;
		this.mute = true;
		this.mediaState = 0;
		this.inputIdentifier = 0;
		this.reference = '';

		this.sensorScreenSaverState = false;
		this.sensorInputState = false;

		this.prefDir = path.join(api.user.storagePath(), 'xboxTv');
		this.authTokenFile = `${this.prefDir}/authToken_${this.host.split('.').join('')}`;
		this.inputsFile = `${this.prefDir}/inputs_${this.host.split('.').join('')}`;
		this.inputsNamesFile = `${this.prefDir}/inputsNames_${this.host.split('.').join('')}`;
		this.inputsTargetVisibilityFile = `${this.prefDir}/inputsTargetVisibility_${this.host.split('.').join('')}`;

		//check if the directory exists, if not then create it
		if (fs.existsSync(this.prefDir) === false) {
			fs.mkdirSync(this.prefDir);
		}
		if (fs.existsSync(this.authTokenFile) === false) {
			fs.writeFileSync(this.authTokenFile, '');
		}
		if (fs.existsSync(this.inputsFile) === false) {
			fs.writeFileSync(this.inputsFile, '');
		}
		if (fs.existsSync(this.inputsNamesFile) === false) {
			fs.writeFileSync(this.inputsNamesFile, '');
		}
		if (fs.existsSync(this.inputsTargetVisibilityFile) === false) {
			fs.writeFileSync(this.inputsTargetVisibilityFile, '');
		}

		//mqtt client
		this.mqtt = new Mqtt({
			enabled: this.mqttEnabled,
			host: this.mqttHost,
			port: this.mqttPort,
			prefix: this.mqttPrefix,
			topic: this.name,
			auth: this.mqttAuth,
			user: this.mqttUser,
			passwd: this.mqttPasswd,
			debug: this.mqttDebug
		});

		this.mqtt.on('connected', (message) => {
			this.log(`Device: ${this.host} ${this.name}, ${message}`);
		})
			.on('error', (error) => {
				this.log.error(`Device: ${this.host} ${this.name}, ${error}`);
			})
			.on('debug', (message) => {
				this.log(`Device: ${this.host} ${this.name}, debug: ${message}`);
			})
			.on('message', (message) => {
				this.log(`Device: ${this.host} ${this.name}, ${message}`);
			})
			.on('disconnected', (message) => {
				this.log(`Device: ${this.host} ${this.name}, ${message}`);
			});

		//web api client
		if (this.webApiControl) {
			this.xboxWebApi = xboxWebApi({
				clientId: this.clientId,
				clientSecret: this.clientSecret,
				userToken: this.userToken,
				uhs: this.userHash
			});
			this.getAuthorizationState();

			setInterval(() => {
				this.getAuthorizationState();
			}, 600000);
		};

		//xbox client
		this.xboxLocalApi = new XboxLocalApi({
			host: this.host,
			xboxLiveId: this.xboxLiveId,
			userToken: this.userToken,
			uhs: this.userHash,
			infoLog: this.disableLogInfo,
			debugLog: this.enableDebugMode
		});

		this.xboxLocalApi.on('connected', (message) => {
			this.log(`Device: ${this.host} ${this.name}, ${message}`);
		})
			.on('deviceInfo', async (firmwareRevision, locale) => {
				if (!this.disableLogDeviceInfo) {
					this.log('-------- %s --------', this.name);
					this.log('Manufacturer: %s', this.manufacturer);
					this.log('Model: %s', this.modelName);
					this.log('Serialnr: %s', this.serialNumber);
					this.log('Firmware: %s', firmwareRevision);
					this.log('----------------------------------');
				}

				if (this.informationService) {
					this.informationService
						.setCharacteristic(Characteristic.Manufacturer, this.manufacturer)
						.setCharacteristic(Characteristic.Model, this.modelName)
						.setCharacteristic(Characteristic.SerialNumber, this.serialNumber)
						.setCharacteristic(Characteristic.FirmwareRevision, firmwareRevision);
				};

				this.firmwareRevision = firmwareRevision;
			})
			.on('stateChanged', (power, titleId, reference, volume, mute, mediaState) => {
				const inputIdentifier = this.inputsReference.indexOf(reference) >= 0 ? this.inputsReference.indexOf(reference) : this.inputsTitleId.indexOf(titleId) >= 0 ? this.inputsTitleId.indexOf(titleId) : this.inputIdentifier;

				const obj = JSON.stringify({
					'power': power,
					'titleId': titleId,
					'app': reference,
					'volume': volume,
					'mute': mute,
					'mediaState': mediaState,
				}, null, 2);

				//update characteristics
				if (this.televisionService) {
					this.televisionService
						.updateCharacteristic(Characteristic.Active, power)
						.updateCharacteristic(Characteristic.ActiveIdentifier, inputIdentifier);
				};

				if (this.speakerService) {
					this.speakerService
						.updateCharacteristic(Characteristic.Volume, volume)
						.updateCharacteristic(Characteristic.Mute, mute);
					if (this.volumeService && this.volumeControl === 1) {
						this.volumeService
							.updateCharacteristic(Characteristic.Brightness, volume)
							.updateCharacteristic(Characteristic.On, !mute);
					};
					if (this.volumeServiceFan && this.volumeControl === 2) {
						this.volumeServiceFan
							.updateCharacteristic(Characteristic.RotationSpeed, volume)
							.updateCharacteristic(Characteristic.On, !mute);
					};
				};

				if (this.sensorPowerService) {
					this.sensorPowerService
						.updateCharacteristic(Characteristic.MotionDetected, power)
				}

				if (this.sensorInputService) {
					const state = power ? (this.inputIdentifier !== inputIdentifier) : false;
					this.sensorInputService
						.updateCharacteristic(Characteristic.MotionDetected, state)
					this.sensorInputState = state;
				}

				if (this.sensorScreenSaverService) {
					const state = power ? (reference === 'Xbox.IdleScreen_8wekyb3d8bbwe!Xbox.IdleScreen.Application') : false;
					this.sensorScreenSaverService
						.updateCharacteristic(Characteristic.MotionDetected, state)
					this.sensorScreenSaverState = state;
				}

				if (this.inputSensorServices) {
					const servicesCount = this.inputSensorServices.length;
					for (let i = 0; i < servicesCount; i++) {
						const state = power ? (this.inputsSensorsReference[i] === reference) : false;
						const displayType = this.inputsSensorsDisplayType[i];
						const characteristicType = [Characteristic.MotionDetected, Characteristic.OccupancyDetected, Characteristic.ContactSensorState][displayType];
						this.inputSensorServices[i]
							.updateCharacteristic(characteristicType, state);
					}
				}

				this.firstRun = false;
				this.power = power;
				this.volume = volume;
				this.mute = mute;
				this.mediaState = mediaState;
				this.reference = reference;
				this.inputIdentifier = inputIdentifier;
				const mqtt = this.mqttEnabled ? this.mqtt.send('State', obj) : false;
			})
			.on('error', (error) => {
				this.log.error(`Device: ${this.host} ${this.name}, ${error}`);
			})
			.on('debug', (message) => {
				this.log(`Device: ${this.host} ${this.name}, debug: ${message}`);
			})
			.on('message', (message) => {
				this.log(`Device: ${this.host} ${this.name}, ${message}`);
			})
			.on('disconnected', (message) => {
				this.log(`Device: ${this.host} ${this.name}, ${message}`);
			});

		//start prepare accessory
		this.prepareAccessory();
	}

	async getAuthorizationState() {
		try {
			this.log.debug(`Device: ${this.host} ${this.name}, requesting authorization state.`);
			this.xboxWebApi._authentication._tokensFile = this.authTokenFile;
			await this.xboxWebApi.isAuthenticated();
			this.webApiEnabled = true;
			const debug = this.enableDebugMode ? this.log(`Device: ${this.host} ${this.name}, Authorized and Web Api enabled.`) : false;

			try {
				this.log.debug(`Device: ${this.host} ${this.name}, requesting web api console data.`);
				//await this.getWebApiConsolesList();
				//await this.getWebApiUserProfile();
				await this.getWebApiInstalledApps();
				//await this.getWebApiStorageDevices();
				await this.getWebApiConsoleStatus();
			} catch (error) {
				this.log.error(`Device: ${this.host} ${this.name}, get web api console data error: ${error}`)
			};
		} catch (error) {
			this.webApiEnabled = false;
			this.log.error(`Device: ${this.host} ${this.name}, not authorized, please use Authorization Manager.`);
		};
	};

	getWebApiConsolesList() {
		return new Promise(async (resolve, reject) => {
			this.log.debug(`Device: ${this.host} ${this.name}, requesting web api consoles list.`);
			try {
				const getConsolesListData = await this.xboxWebApi.getProvider('smartglass').getConsolesList();
				const debug = this.enableDebugMode ? this.log(`Device: ${this.host} ${this.name}, debug getConsolesListData, result: ${getConsolesListData.result[0]}, ${getConsolesListData.result[0].storageDevices[0]}`) : false
				const consolesListData = getConsolesListData.result;

				this.consolesId = [];
				this.consolesName = [];
				this.consolesLocale = [];
				this.consolesRegion = [];
				this.consolesConsoleType = [];
				this.consolesPowerState = [];
				this.consolesDigitalAssistantRemoteControlEnabled = [];
				this.consolesConsoleStreamingEnabled = [];
				this.consolesRemoteManagementEnabled = [];
				this.consolesWirelessWarning = [];
				this.consolesOutOfHomeWarning = [];

				this.consolesStorageDeviceId = [];
				this.consolesStorageDeviceName = [];
				this.consolesIsDefault = [];
				this.consolesFreeSpaceBytes = [];
				this.consolesTotalSpaceBytes = [];
				this.consolesIsGen9Compatible = [];

				const consolesList = consolesListData;
				for (const console of consolesList) {
					const id = console.id;
					const name = console.name;
					const locale = console.locale;
					const region = console.region;
					const consoleType = console.consoleType;
					const powerState = CONSTANS.ConsolePowerState[console.powerState]; // 0 - Off, 1 - On, 2 - ConnectedStandby, 3 - SystemUpdate
					const digitalAssistantRemoteControlEnabled = (console.digitalAssistantRemoteControlEnabled === true);
					const remoteManagementEnabled = (console.remoteManagementEnabled === true);
					const consoleStreamingEnabled = (console.consoleStreamingEnabled === true);
					const wirelessWarning = (console.wirelessWarning === true);
					const outOfHomeWarning = (console.outOfHomeWarning === true);

					this.consolesId.push(id);
					this.consolesName.push(name);
					this.consolesLocale.push(locale);
					this.consolesRegion.push(region);
					this.consolesConsoleType.push(consoleType);
					this.consolesPowerState.push(powerState);
					this.consolesDigitalAssistantRemoteControlEnabled.push(digitalAssistantRemoteControlEnabled);
					this.consolesRemoteManagementEnabled.push(remoteManagementEnabled);
					this.consolesConsoleStreamingEnabled.push(consoleStreamingEnabled);
					this.consolesWirelessWarning.push(wirelessWarning);
					this.consolesOutOfHomeWarning.push(outOfHomeWarning);

					const consolesStorageDevices = console.storageDevices;
					for (const consoleStorageDevice of consolesStorageDevices) {
						const storageDeviceId = consoleStorageDevice.storageDeviceId;
						const storageDeviceName = consoleStorageDevice.storageDeviceName;
						const isDefault = (consoleStorageDevice.isDefault === true);
						const freeSpaceBytes = consoleStorageDevice.freeSpaceBytes;
						const totalSpaceBytes = consoleStorageDevice.totalSpaceBytes;
						const isGen9Compatible = consoleStorageDevice.isGen9Compatible;

						this.consolesStorageDeviceId.push(storageDeviceId);
						this.consolesStorageDeviceName.push(storageDeviceName);
						this.consolesIsDefault.push(isDefault);
						this.consolesFreeSpaceBytes.push(freeSpaceBytes);
						this.consolesTotalSpaceBytes.push(totalSpaceBytes);
						this.consolesIsGen9Compatible.push(isGen9Compatible);
					}
				}
				resolve(true);
			} catch (error) {
				reject(error);
				this.log.error(`Device: ${this.host} ${this.name}, get Consoles List error: ${error}`)
			};
		});
	}

	getWebApiUserProfile() {
		return new Promise(async (resolve, reject) => {
			this.log.debug(`Device: ${this.host} ${this.name}, requesting web api user profile.`);
			try {
				const getUserProfileData = await this.xboxWebApi.getProvider('profile').getUserProfile();
				const debug = this.enableDebugMode ? this.log(`Device: ${this.host} ${this.name}, debug getUserProfileData, result: ${JSON.stringify(getUserProfileData.profileUsers[0], null, 2)}, ${JSON.stringify(getUserProfileData.profileUsers[0].settings[0], null, 2)}`) : false
				const userProfileData = getUserProfileData.profileUsers;

				this.userProfileId = [];
				this.userProfileHostId = [];
				this.userProfileIsSponsoredUser = [];

				this.userProfileSettingsId = [];
				this.userProfileSettingsValue = [];

				const profileUsers = userProfileData;
				for (const userProfile of profileUsers) {
					const id = userProfile.id;
					const hostId = userProfile.hostId;
					const isSponsoredUser = userProfile.isSponsoredUser;

					this.userProfileId.push(id);
					this.userProfileHostId.push(hostId);
					this.userProfileIsSponsoredUser.push(isSponsoredUser);

					const profileUsersSettings = userProfile.settings;
					for (const userProfileSettings of profileUsersSettings) {
						const id = userProfileSettings.id;
						const value = userProfileSettings.value;

						this.userProfileSettingsId.push(id);
						this.userProfileSettingsValue.push(value);
					};
				};
				resolve(true);
			} catch (error) {
				reject(error);
				this.log.error(`Device: ${this.host} ${this.name}, get User Profile error: ${error}`)
			};
		});
	}

	getWebApiInstalledApps() {
		return new Promise(async (resolve, reject) => {
			this.log.debug(`Device: ${this.host} ${this.name}, requesting installed apps from your Xbox Live account.`);
			try {
				const getInstalledAppsData = await this.xboxWebApi.getProvider('smartglass').getInstalledApps(this.xboxLiveId);
				const debug = this.enableDebugMode ? this.log(`Device: ${this.host} ${this.name}, debug getInstalledAppsData: ${JSON.stringify(getInstalledAppsData.result, null, 2)}`) : false

				const inputsArr = CONSTANS.DefaultInputs.slice();

				//get installed inputs/apps from web
				const inputsData = getInstalledAppsData.result;
				const inputs = inputsData;
				for (const input of inputs) {
					const oneStoreProductId = input.oneStoreProductId;
					const titleId = input.titleId;
					const aumid = input.aumid;
					const lastActiveTime = input.lastActiveTime;
					const isGame = (input.isGame === true);
					const name = input.name;
					const contentType = input.contentType;
					const instanceId = input.instanceId;
					const storageDeviceId = input.storageDeviceId;
					const uniqueId = input.uniqueId;
					const legacyProductId = input.legacyProductId;
					const version = input.version;
					const sizeInBytes = input.sizeInBytes;
					const installTime = input.installTime;
					const updateTime = input.updateTime;
					const parentId = input.parentId;
					const type = 'APPLICATION';

					const inputsObj = {
						'name': name,
						'titleId': titleId,
						'reference': aumid,
						'oneStoreProductId': oneStoreProductId,
						'type': type,
						'contentType': contentType
					};
					inputsArr.push(inputsObj);
				};
				const obj = JSON.stringify(inputsArr, null, 2);
				const writeInputs = await fsPromises.writeFile(this.inputsFile, obj);
				const debug1 = this.enableDebugMode ? this.log(`Device: ${this.host} ${this.name}, saved inputs/apps list: ${obj}`) : false
				resolve(true);
			} catch (error) {
				reject(error);
				this.log.error(`Device: ${this.host} ${this.name}, with liveId: ${this.xboxLiveId}, get Installed Apps error: ${error}`);
			};
		});
	}

	getWebApiStorageDevices() {
		return new Promise(async (resolve, reject) => {
			this.log.debug(`Device: ${this.host} ${this.name}, requesting web api storage devices.`);
			try {
				const getStorageDevicesData = await this.xboxWebApi.getProvider('smartglass').getStorageDevices(this.xboxLiveId);
				const debug = this.enableDebugMode ? this.log(`Device: ${this.host} ${this.name}, debug getStorageDevicesData, result: ${JSON.stringify(getStorageDevicesData, null, 2)}`) : false

				const storageDeviceData = getStorageDevicesData.result;
				const deviceId = getStorageDevicesData.deviceId;
				const agentUserId = getStorageDevicesData.agentUserId;

				this.storageDeviceId = [];
				this.storageDeviceName = [];
				this.isDefault = [];
				this.freeSpaceBytes = [];
				this.totalSpaceBytes = [];
				this.isGen9Compatible = [];

				const storageDevices = storageDeviceData;
				for (const storageDevice of storageDevices) {
					const storageDeviceId = storageDevice.storageDeviceId;
					const storageDeviceName = storageDevice.storageDeviceName;
					const isDefault = (storageDevice.isDefault === true);
					const freeSpaceBytes = storageDevice.freeSpaceBytes;
					const totalSpaceBytes = storageDevice.totalSpaceBytes;
					const isGen9Compatible = storageDevice.isGen9Compatible;

					this.storageDeviceId.push(storageDeviceId);
					this.storageDeviceName.push(storageDeviceName);
					this.isDefault.push(isDefault);
					this.freeSpaceBytes.push(freeSpaceBytes);
					this.totalSpaceBytes.push(totalSpaceBytes);
					this.isGen9Compatible.push(isGen9Compatible);
				};
				resolve(true);
			} catch (error) {
				reject(error);
				this.log.error(`Device: ${this.host} ${this.name}, with liveId: ${this.xboxLiveId}, get Storage Devices error: ${error}`);
			};
		});
	}

	getWebApiConsoleStatus() {
		return new Promise(async (resolve, reject) => {
			this.log.debug(`Device: ${this.host} ${this.name}, requesting device info from Web API.`);
			try {
				const getConsoleStatusData = await this.xboxWebApi.getProvider('smartglass').getConsoleStatus(this.xboxLiveId);
				const debug = this.enableDebugMode ? this.log(`Device: ${this.host} ${this.name}, debug getConsoleStatusData, result: ${JSON.stringify(getConsoleStatusData, null, 2)}`) : false
				const consoleStatusData = getConsoleStatusData;

				const id = consoleStatusData.id;
				const name = consoleStatusData.name;
				const locale = consoleStatusData.locale;
				const region = consoleStatusData.region;
				const consoleType = CONSTANS.ConsoleName[consoleStatusData.consoleType];
				const powerState = (CONSTANS.ConsolePowerState[consoleStatusData.powerState] === 1); // 0 - Off, 1 - On, 2 - InStandby, 3 - SystemUpdate
				const playbackState = (CONSTANS.ConsolePlaybackState[consoleStatusData.playbackState] === 1); // 0 - Stopped, 1 - Playng, 2 - Paused
				const loginState = consoleStatusData.loginState;
				const focusAppAumid = consoleStatusData.focusAppAumid;
				const isTvConfigured = (consoleStatusData.isTvConfigured === true);
				const digitalAssistantRemoteControlEnabled = (consoleStatusData.digitalAssistantRemoteControlEnabled === true);
				const consoleStreamingEnabled = (consoleStatusData.consoleStreamingEnabled === true);
				const remoteManagementEnabled = (consoleStatusData.remoteManagementEnabled === true);

				//this.serialNumber = id;
				this.modelName = consoleType;
				//this.power = powerState;
				//this.mediaState = playbackState;
				if (this.informationService) {
					this.informationService
						.setCharacteristic(Characteristic.Model, this.modelName)
				};
				resolve(true);
			} catch (error) {
				reject(error);
				this.log.error(`Device: ${this.host} ${this.name}, with liveId: ${this.xboxLiveId}, get Console Status error: ${error}`);
			};
		});
	}

	//Prepare accessory
	prepareAccessory() {
		this.log.debug('prepareAccessory');

		//accessory
		const accessoryName = this.name;
		const accessoryUUID = UUID.generate(this.xboxLiveId);
		const accessoryCategory = Categories.TV_SET_TOP_BOX;
		const accessory = new Accessory(accessoryName, accessoryUUID, accessoryCategory);

		//Pinformation service
		this.log.debug('prepareInformationService');
		const manufacturer = this.manufacturer;
		const modelName = this.modelName;
		const serialNumber = this.serialNumber;
		const firmwareRevision = this.firmwareRevision;

		this.informationService = accessory.getService(Service.AccessoryInformation)
			.setCharacteristic(Characteristic.Manufacturer, manufacturer)
			.setCharacteristic(Characteristic.Model, modelName)
			.setCharacteristic(Characteristic.SerialNumber, serialNumber)
			.setCharacteristic(Characteristic.FirmwareRevision, firmwareRevision);

		//Prepare television service
		this.log.debug('prepareTelevisionService');
		this.televisionService = new Service.Television(`${accessoryName} Television`, 'Television');
		this.televisionService.setCharacteristic(Characteristic.ConfiguredName, accessoryName);
		this.televisionService.setCharacteristic(Characteristic.SleepDiscoveryMode, Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);

		this.televisionService.getCharacteristic(Characteristic.Active)
			.onGet(async () => {
				const state = this.power;
				const logInfo = this.disableLogInfo ? false : this.log(`Device: ${this.host} ${accessoryName}, get Power state successful: ${state ? 'ON' : 'OFF'}`);
				return state;
			})
			.onSet(async (state) => {
				try {
					const setPower = (state && !this.power) ? await this.xboxLocalApi.powerOn() : (!state && this.power) ? await this.xboxLocalApi.powerOff() : false;
					const logInfo = this.disableLogInfo ? false : this.log(`Device: ${this.host} ${accessoryName}, set Power successful: ${state ? 'ON' : 'OFF'}`);
				} catch (error) {
					this.log.error(`Device: ${this.host} ${accessoryName}, set Power, error: ${error}`);
				};
			});

		this.televisionService.getCharacteristic(Characteristic.ActiveIdentifier)
			.onGet(async () => {
				const inputIdentifier = this.inputIdentifier;
				const inputName = this.inputsName[inputIdentifier];
				const inputReference = this.inputsReference[inputIdentifier];
				const inputOneStoreProductId = this.inputsOneStoreProductId[inputIdentifier];
				const logInfo = this.disableLogInfo || this.firstRun ? false : this.log(`Device: ${this.host} ${accessoryName}, get Input successful, input: ${inputName}, reference: ${inputReference}, product Id: ${inputOneStoreProductId}`);
				return inputIdentifier;
			})
			.onSet(async (inputIdentifier) => {
				const inputName = this.inputsName[inputIdentifier];
				const inputReference = this.inputsReference[inputIdentifier];
				const inputOneStoreProductId = this.inputsOneStoreProductId[inputIdentifier];
				const setDashboard = (inputOneStoreProductId === 'Dashboard' || inputOneStoreProductId === 'Settings' || inputOneStoreProductId === 'SettingsTv' || inputOneStoreProductId === 'Accessory' || inputOneStoreProductId === 'Screensaver' || inputOneStoreProductId === 'NetworkTroubleshooter' || inputOneStoreProductId === 'XboxGuide');
				const setTelevision = (inputOneStoreProductId === 'Television');
				const setApp = ((inputOneStoreProductId && inputOneStoreProductId !== '0') && !setDashboard && !setTelevision);
				try {
					const setInput = this.webApiEnabled ? setApp ? await this.xboxWebApi.getProvider('smartglass').launchApp(this.xboxLiveId, inputOneStoreProductId) : setDashboard ? await this.xboxWebApi.getProvider('smartglass').launchDashboard(this.xboxLiveId) : setTelevision ? await this.xboxWebApi.getProvider('smartglass').launchOneGuide(this.xboxLiveId) : false : false;
					const logInfo = this.disableLogInfo || this.firstRun ? false : this.log(`Device: ${this.host} ${accessoryName}, set Input successful, input: ${inputName},, reference: ${inputReference}, product Id: ${inputOneStoreProductId}`);
				} catch (error) {
					this.log.error(`Device: ${this.host} ${accessoryName}, set Input error: ${error}`);
				};
			});

		this.televisionService.getCharacteristic(Characteristic.RemoteKey)
			.onSet(async (command) => {
				let channelName;
				switch (command) {
					case Characteristic.RemoteKey.REWIND:
						command = 'rewind';
						channelName = 'systemMedia';
						break;
					case Characteristic.RemoteKey.FAST_FORWARD:
						command = 'fastForward';
						channelName = 'systemMedia';
						break;
					case Characteristic.RemoteKey.NEXT_TRACK:
						command = 'nextTrack';
						channelName = 'systemMedia';
						break;
					case Characteristic.RemoteKey.PREVIOUS_TRACK:
						command = 'prevTrack';
						channelName = 'systemMedia';
						break;
					case Characteristic.RemoteKey.ARROW_UP:
						command = 'up';
						channelName = 'systemInput';
						break;
					case Characteristic.RemoteKey.ARROW_DOWN:
						command = 'down';
						channelName = 'systemInput';
						break;
					case Characteristic.RemoteKey.ARROW_LEFT:
						command = 'left';
						channelName = 'systemInput';
						break;
					case Characteristic.RemoteKey.ARROW_RIGHT:
						command = 'right';
						channelName = 'systemInput';
						break;
					case Characteristic.RemoteKey.SELECT:
						command = 'a';
						channelName = 'systemInput';
						break;
					case Characteristic.RemoteKey.BACK:
						command = 'b';
						channelName = 'systemInput';
						break;
					case Characteristic.RemoteKey.EXIT:
						command = 'nexus';
						channelName = 'systemInput';
						break;
					case Characteristic.RemoteKey.PLAY_PAUSE:
						command = 'playpause';
						channelName = 'systemMedia';
						break;
					case Characteristic.RemoteKey.INFORMATION:
						command = this.infoButtonCommand;
						channelName = 'systemInput';
						break;
				};
				try {
					const sendCommand = this.power ? this.webApiEnabled ? await this.xboxWebApi.getProvider('smartglass').sendButtonPress(this.xboxLiveId, command) : await this.xboxWebApi.getProvider('smartglass').sendButtonPress(this.xboxLiveId, command) : false//await this.xboxLocalApi.sendCommand(channelName, command) : false;
					const logInfo = this.disableLogInfo || this.firstRun ? false : this.log(`Device: ${this.host} ${accessoryName}, Remote Key command successful: ${command}`);
				} catch (error) {
					this.log.error(`Device: ${this.host} ${accessoryName}, set Remote Key command error: ${JSON.stringify(error, null, 2)}`);
				};
			});

		this.televisionService.getCharacteristic(Characteristic.CurrentMediaState)
			.onGet(async () => {
				//apple, 0 - PLAY, 1 - PAUSE, 2 - STOP, 3 - LOADING, 4 - INTERRUPTED
				//xbox, 0 - STOP, 1 - PLAY, 2 - PAUSE
				const value = [2, 0, 1, 3, 4][this.mediaState];
				const logInfo = this.disableLogInfo || this.firstRun ? false : this.log(`Device: ${this.host} ${accessoryName}, get Current Media state successful: ${['PLAY', 'PAUSE', 'STOP', 'LOADING', 'INTERRUPTED'][value]}`);
				return value;
			});

		this.televisionService.getCharacteristic(Characteristic.TargetMediaState)
			.onGet(async () => {
				//0 - PLAY, 1 - PAUSE, 2 - STOP
				const value = [2, 0, 1, 3, 4][this.mediaState];
				const logInfo = this.disableLogInfo || this.firstRun ? false : this.log(`Device: ${this.host} ${accessoryName}, get Target Media state successful: ${['PLAY', 'PAUSE', 'STOP', 'LOADING', 'INTERRUPTED'][value]}`);
				return value;
			})
			.onSet(async (value) => {
				try {
					const newMediaState = value;
					const setMediaState = this.power ? false : false;
					const logInfo = this.disableLogInfo || this.firstRun ? false : this.log(`Device: ${this.host} ${accessoryName}, set Target Media state successful: ${['PLAY', 'PAUSE', 'STOP', 'LOADING', 'INTERRUPTED'][value]}`);
				} catch (error) {
					this.log.error(`Device: ${this.host} ${accessoryName} set Target Media state error: ${error}`);
				};
			});

		this.televisionService.getCharacteristic(Characteristic.PowerModeSelection)
			.onSet(async (command) => {
				switch (command) {
					case Characteristic.PowerModeSelection.SHOW:
						command = 'nexus';
						break;
					case Characteristic.PowerModeSelection.HIDE:
						command = 'b';
						break;
				};
				try {
					const channelName = 'systemInput';
					const setPowerModeSelection = this.power ? this.webApiEnabled ? await this.xboxWebApi.getProvider('smartglass').sendButtonPress(this.xboxLiveId, command) : await this.xboxWebApi.getProvider('smartglass').sendButtonPress(this.xboxLiveId, command) : false//await this.xboxLocalApi.sendCommand(channelName, command) : false;
					const logInfo = this.disableLogInfo || this.firstRun ? false : this.log(`Device: ${this.host} ${accessoryName}, set Power Mode Selection command successful: ${command}`);
				} catch (error) {
					this.log.error(`Device: ${this.host} ${accessoryName}, set Power Mode Selection command error: ${error}`);
				};
			});

		accessory.addService(this.televisionService);

		//Prepare speaker service
		this.log.debug('prepareSpeakerService');
		this.speakerService = new Service.TelevisionSpeaker(`${accessoryName} Speaker`, 'Speaker');
		this.speakerService
			.setCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE)
			.setCharacteristic(Characteristic.VolumeControlType, Characteristic.VolumeControlType.ABSOLUTE)
			.getCharacteristic(Characteristic.VolumeSelector)
			.onSet(async (command) => {
				switch (command) {
					case Characteristic.VolumeSelector.INCREMENT:
						command = 'volUp';
						break;
					case Characteristic.VolumeSelector.DECREMENT:
						command = 'volDown';
						break;
				};
				try {
					const channelName = 'tvRemote';
					const setVolume = (this.power && this.webApiEnabled) ? await this.xboxWebApi.getProvider('smartglass').sendButtonPress(this.xboxLiveId, command) : false;
					const logInfo = this.disableLogInfo || this.firstRun ? false : this.log(`Device: ${this.host} ${accessoryName}, set Volume command successful: ${command}`);
				} catch (error) {
					this.log.error(`Device: ${this.host} ${accessoryName}, set Volume command error: ${error}`);
				};
			});

		this.speakerService.getCharacteristic(Characteristic.Volume)
			.onGet(async () => {
				const volume = this.volume;
				const logInfo = this.disableLogInfo || this.firstRun ? false : this.log(`Device: ${this.host} ${accessoryName}, get Volume successful: ${volume}`);
				return volume;
			})
			.onSet(async (volume) => {
				if (volume === 0 || volume === 100) {
					volume = this.volume;
				};
				const logInfo = this.disableLogInfo || this.firstRun ? false : this.log(`Device: ${this.host} ${accessoryName}, set Volume successful: ${volume}`);
			});

		this.speakerService.getCharacteristic(Characteristic.Mute)
			.onGet(async () => {
				const state = this.mute;
				const logInfo = this.disableLogInfo ? false : this.log(`Device: ${this.host} ${accessoryName}, get Mute successful: ${state ? 'ON' : 'OFF'}`);
				return state;
			})
			.onSet(async (state) => {
				try {
					const toggleMute = (this.power && this.webApiEnabled) ? state ? await this.xboxWebApi.getProvider('smartglass').mute(this.xboxLiveId) : await this.xboxWebApi.getProvider('smartglass').unmute(this.xboxLiveId) : false;
					const logInfo = this.disableLogInfo || this.firstRun ? false : this.log(`Device: ${this.host} ${accessoryName}, set Mute successful: ${state ? 'ON' : 'OFF'}`);
				} catch (error) {
					this.log.error(`Device: ${this.host} ${accessoryName}, set Mute error: ${error}`);
				};
			});

		accessory.addService(this.speakerService);

		//Prepare volume service
		if (this.volumeControl >= 1) {
			this.log.debug('prepareVolumeService');
			if (this.volumeControl === 1) {
				this.volumeService = new Service.Lightbulb(`${accessoryName} Volume`, 'Volume');
				this.volumeService.getCharacteristic(Characteristic.Brightness)
					.onGet(async () => {
						const volume = this.volume;
						return volume;
					})
					.onSet(async (volume) => {
						const setVolume = this.power ? this.speakerService.setCharacteristic(Characteristic.Volume, volume) : false;
					});
				this.volumeService.getCharacteristic(Characteristic.On)
					.onGet(async () => {
						const state = !this.mute;
						return state;
					})
					.onSet(async (state) => {
						const setMute = this.power ? this.speakerService.setCharacteristic(Characteristic.Mute, !state) : false;
					});

				accessory.addService(this.volumeService);
			}

			if (this.volumeControl === 2) {
				this.volumeServiceFan = new Service.Fan(`${accessoryName} Volume`, 'Volume');
				this.volumeServiceFan.getCharacteristic(Characteristic.RotationSpeed)
					.onGet(async () => {
						const volume = this.volume;
						return volume;
					})
					.onSet(async (volume) => {
						const setVolume = this.power ? this.speakerService.setCharacteristic(Characteristic.Volume, volume) : false;
					});
				this.volumeServiceFan.getCharacteristic(Characteristic.On)
					.onGet(async () => {
						const state = !this.mute;
						return state;
					})
					.onSet(async (state) => {
						const setMute = this.power ? this.speakerService.setCharacteristic(Characteristic.Mute, !state) : false;
					});

				accessory.addService(this.volumeServiceFan);
			}
		}

		//prepare sensor service
		if (this.sensorPower) {
			this.log.debug('prepareSensorPowerService')
			this.sensorPowerService = new Service.MotionSensor(`${accessoryName} Power Sensor`, `Power Sensor`);
			this.sensorPowerService.getCharacteristic(Characteristic.MotionDetected)
				.onGet(async () => {
					const state = this.power;
					return state;
				});
			accessory.addService(this.sensorPowerService);
		};

		if (this.sensorInput) {
			this.log.debug('prepareSensorInputService')
			this.sensorInputService = new Service.MotionSensor(`${accessoryName} Input Sensor`, `Input Sensor`);
			this.sensorInputService.getCharacteristic(Characteristic.MotionDetected)
				.onGet(async () => {
					const state = this.sensorInputState;
					return state;
				});
			accessory.addService(this.sensorInputService);
		};

		if (this.sensorScreenSaver) {
			this.log.debug('prepareSensorScreenSaverService')
			this.sensorScreenSaverService = new Service.MotionSensor(`${accessoryName} Screen Saver Sensor`, `Screen Saver Sensor`);
			this.sensorScreenSaverService.getCharacteristic(Characteristic.MotionDetected)
				.onGet(async () => {
					const state = this.power ? this.sensorScreenSaverState : false;
					return state;
				});
			accessory.addService(this.sensorScreenSaverService);
		};

		//Prepare inputs services
		this.log.debug('prepareInputServices');

		const savedInputs = ((fs.readFileSync(this.inputsFile)).length > 0) ? JSON.parse(fs.readFileSync(this.inputsFile)) : [];
		const debug = this.enableDebugMode ? this.log(`Device: ${this.host} ${accessoryName}, read saved Inputs successful, inpits: ${JSON.stringify(savedInputs, null, 2)}`) : false;

		const savedInputsNames = ((fs.readFileSync(this.inputsNamesFile)).length > 0) ? JSON.parse(fs.readFileSync(this.inputsNamesFile)) : {};
		const debug1 = this.enableDebugMode ? this.log(`Device: ${this.host} ${accessoryName}, read saved custom Inputs Names successful, names: ${JSON.stringify(savedInputsNames, null, 2)}`) : false;

		const savedInputsTargetVisibility = ((fs.readFileSync(this.inputsTargetVisibilityFile)).length > 0) ? JSON.parse(fs.readFileSync(this.inputsTargetVisibilityFile)) : {};
		const debug2 = this.enableDebugMode ? this.log(`Device: ${this.host} ${accessoryName}, read saved Inputs Target Visibility successful, states: ${JSON.stringify(savedInputsTargetVisibility, null, 2)}`) : false;

		//check available inputs and filter costom inputs
		const allInputs = (this.getInputsFromDevice && savedInputs.length > 0) ? savedInputs : this.inputs;
		for (const input of allInputs) {
			const contentType = input.contentType;
			const filterGames = this.filterGames ? (contentType !== 'Game') : true;
			const filterApps = this.filterApps ? (contentType !== 'App') : true;
			const filterSystemApps = this.filterSystemApps ? (contentType !== 'systemApp') : true;
			const filterDlc = this.filterDlc ? (contentType !== 'Dlc') : true;
			const push = (this.getInputsFromDevice) ? (filterGames && filterApps && filterSystemApps && filterDlc) ? this.inputsArr.push(input) : false : this.inputsArr.push(input);
		}

		//check available inputs and possible inputs count (max 93)
		const inputs = this.inputsArr;
		const inputsCount = inputs.length;
		const maxInputsCount = (inputsCount < 93) ? inputsCount : 93;
		for (let j = 0; j < maxInputsCount; j++) {
			//get input 
			const input = inputs[j];

			//get title Id
			const inputTitleId = (input.titleId) ? input.titleId : undefined;

			//get input reference
			const inputReference = (input.reference) ? input.reference : undefined;

			//get input oneStoreProductId
			const inputOneStoreProductId = (input.oneStoreProductId) ? input.oneStoreProductId : undefined;

			//get input name
			const inputName = (savedInputsNames[inputTitleId]) ? savedInputsNames[inputTitleId] : (savedInputsNames[inputReference]) ? savedInputsNames[inputReference] : (savedInputsNames[inputOneStoreProductId]) ? savedInputsNames[inputOneStoreProductId] : input.name;

			//get input type
			const inputType = (input.type) ? CONSTANS.InputSourceTypes.indexOf(input.type) : 10;

			//get input configured
			const isConfigured = 1;

			//get input visibility state
			const currentVisibility = (savedInputsTargetVisibility[inputTitleId]) ? savedInputsTargetVisibility[inputTitleId] : (savedInputsTargetVisibility[inputReference]) ? savedInputsTargetVisibility[inputReference] : (savedInputsTargetVisibility[inputOneStoreProductId]) ? savedInputsTargetVisibility[inputOneStoreProductId] : 0;
			const targetVisibility = currentVisibility;

			const inputService = new Service.InputSource(inputName, `Input ${j}`);
			inputService
				.setCharacteristic(Characteristic.Identifier, j)
				.setCharacteristic(Characteristic.ConfiguredName, inputName)
				.setCharacteristic(Characteristic.IsConfigured, isConfigured)
				.setCharacteristic(Characteristic.InputSourceType, inputType)
				.setCharacteristic(Characteristic.CurrentVisibilityState, currentVisibility)
				.setCharacteristic(Characteristic.TargetVisibilityState, targetVisibility);

			inputService
				.getCharacteristic(Characteristic.ConfiguredName)
				.onSet(async (name) => {
					const nameIdentifier = (inputTitleId) ? inputTitleId : (inputReference) ? inputReference : (inputOneStoreProductId) ? inputOneStoreProductId : false;
					savedInputsNames[nameIdentifier] = name;
					const newCustomName = JSON.stringify(savedInputsNames, null, 2);
					try {
						const writeNewCustomName = nameIdentifier ? await fsPromises.writeFile(this.inputsNamesFile, newCustomName) : false;
						const logInfo = this.disableLogInfo || this.firstRun ? false : this.log(`Device: ${this.host} ${accessoryName}, saved new Input name successful, name: ${newCustomName}, product Id: ${inputOneStoreProductId}`);
					} catch (error) {
						this.log.error(`Device: ${this.host} ${accessoryName}, saved new Input Name error: ${error}`);
					}
				});

			inputService
				.getCharacteristic(Characteristic.TargetVisibilityState)
				.onSet(async (state) => {
					const targetVisibilityIdentifier = (inputTitleId) ? inputTitleId : (inputReference) ? inputReference : (inputOneStoreProductId) ? inputOneStoreProductId : false;
					savedInputsTargetVisibility[targetVisibilityIdentifier] = state;
					const newTargetVisibility = JSON.stringify(savedInputsTargetVisibility, null, 2);
					try {
						const writeNewTargetVisibility = targetVisibilityIdentifier ? await fsPromises.writeFile(this.inputsTargetVisibilityFile, newTargetVisibility) : false;
						const logInfo = this.disableLogInfo || this.firstRun ? false : this.log(`Device: ${this.host} ${accessoryName}, saved new Target Visibility successful, input: ${inputName}, state: ${state ? 'HIDEN' : 'SHOWN'}`);
						inputService.setCharacteristic(Characteristic.CurrentVisibilityState, state);
					} catch (error) {
						this.log.error(`Device: ${this.host} ${accessoryName}, saved new Target Visibility error, input: ${inputName}, error: ${error}`);
					}
				});

			this.inputsTitleId.push(inputTitleId);
			this.inputsReference.push(inputReference);
			this.inputsOneStoreProductId.push(inputOneStoreProductId);
			this.inputsName.push(inputName);
			this.inputsType.push(inputType);

			this.televisionService.addLinkedService(inputService);
			accessory.addService(inputService);
		}

		//prepare sonsor service
		const inputsSensors = this.sensorInputs;
		const inputsSensorsCount = inputsSensors.length;
		const availableInputsSensorsCount = 94 - maxInputsCount;
		const maxInputsSensorsCount = (availableInputsSensorsCount > 0) ? (availableInputsSensorsCount > inputsSensorsCount) ? inputsSensorsCount : availableInputsSensorsCount : 0;
		if (maxInputsSensorsCount > 0) {
			this.log.debug('prepareInputSensorServices');
			this.inputSensorServices = [];
			for (let i = 0; i < maxInputsSensorsCount; i++) {
				//get sensor
				const inputSensor = inputsSensors[i];

				//get sensor name		
				const inputSensorName = inputSensor.name;

				//get sensor reference
				const inputSensorReference = inputSensor.reference;

				//get sensor display type
				const inputSensorDisplayType = inputSensor.displayType || -1;

				if (inputSensorDisplayType === -1) {
					return;
				}

				const serviceType = [Service.MotionSensor, Service.OccupancySensor, Service.ContactSensor][inputSensorDisplayType];
				const characteristicType = [Characteristic.MotionDetected, Characteristic.OccupancyDetected, Characteristic.ContactSensorState][inputSensorDisplayType];
				const inputSensorService = new serviceType(`${accessoryName} ${inputSensorName}`, `Sensor ${inputSensorName}`);
				inputSensorService.getCharacteristic(characteristicType)
					.onGet(async () => {
						const state = this.power ? (this.reference === inputSensorReference) : false;
						return state;
					});

				this.inputsSensorsReference.push(inputSensorReference);
				this.inputSensorServices.push(inputSensorService);
				accessory.addService(this.inputSensorServices[i]);
			}
		}

		//Prepare buttons services
		//check available buttons and possible buttons count (max 94)
		const buttons = this.buttons;
		const buttonsCount = buttons.length;
		const availableButtonsCount = (94 - (maxInputsCount + maxInputsSensorsCount));
		const maxButtonsCount = (availableButtonsCount > 0) ? (availableButtonsCount >= buttonsCount) ? buttonsCount : availableButtonsCount : 0;
		if (maxButtonsCount > 0) {
			this.log.debug('prepareButtonServices');
			for (let i = 0; i < maxButtonsCount; i++) {
				//button 
				const button = buttons[i];

				//get button command
				const buttonCommand = (button.command) ? button.command : '';

				//get button name
				const buttonName = (button.name) ? button.name : buttonCommand;

				//get button display type
				const buttonDisplayType = (button.displayType) ? button.displayType : 0;

				//get button mode
				let buttonMode = 0;
				let channelName = '';
				let command = '';
				if (buttonCommand in CONSTANS.SystemMediaCommands) {
					buttonMode = 0;
					channelName = 'systemMedia';
					command = buttonCommand;
				} else if (buttonCommand in CONSTANS.SystemInputCommands) {
					buttonMode = 1;
					channelName = 'systemInput';
					command = buttonCommand;
				} else if (buttonCommand in CONSTANS.TvRemoteCommands) {
					buttonMode = 2;
					channelName = 'tvRemote';
				} else if (buttonCommand === 'recordGameDvr') {
					buttonMode = 3;
					command = buttonCommand;
				} else if (buttonCommand === 'reboot') {
					buttonMode = 4;
				} else if (buttonCommand === 'switchAppGame') {
					buttonMode = 5;
				};

				//get button inputOneStoreProductId
				const buttonOneStoreProductId = (button.oneStoreProductId) ? button.oneStoreProductId : '0';

				const serviceType = [Service.Outlet, Service.Switch][buttonDisplayType];
				const buttonService = new serviceType(`${accessoryName} ${buttonName}`, `Button ${i}`);
				buttonService.getCharacteristic(Characteristic.On)
					.onGet(async () => {
						const state = false;
						const logInfo = this.disableLogInfo || this.firstRun ? false : this.log(`Device: ${this.host} ${accessoryName}, get Button state successful: ${state}`);
						return state;
					})
					.onSet(async (state) => {
						const setDashboard = (buttonOneStoreProductId === 'Dashboard' || buttonOneStoreProductId === 'Settings' || buttonOneStoreProductId === 'SettingsTv' || buttonOneStoreProductId === 'Accessory' || buttonOneStoreProductId === 'Screensaver' || buttonOneStoreProductId === 'NetworkTroubleshooter' || buttonOneStoreProductId === 'XboxGuide');
						const setTelevision = (buttonOneStoreProductId === 'Television');
						const setApp = ((buttonOneStoreProductId && buttonOneStoreProductId !== '0') && !setDashboard && !setTelevision);
						try {
							const setCommand = (this.power && state && this.webApiEnabled && buttonMode <= 2) ? await this.xboxWebApi.getProvider('smartglass').sendButtonPress(this.xboxLiveId, command) : false
							const recordGameDvr = (this.power && state && buttonMode === 3) ? await this.xboxLocalApi.recordGameDvr() : false;
							const rebootConsole = (this.power && state && this.webApiEnabled && buttonMode === 4) ? await this.xboxWebApi.getProvider('smartglass').reboot(this.xboxLiveId) : false;
							const setAppInput = (this.power && state && this.webApiEnabled && buttonMode === 5) ? setApp ? await this.xboxWebApi.getProvider('smartglass').launchApp(this.xboxLiveId, buttonOneStoreProductId) : setDashboard ? await this.xboxWebApi.getProvider('smartglass').launchDashboard(this.xboxLiveId) : setTelevision ? await this.xboxWebApi.getProvider('smartglass').launchOneGuide(this.xboxLiveId) : false : false;
							const logInfo = this.disableLogInfo || this.firstRun ? false : this.log(`Device: ${this.host} ${taccessoryName}, set button successful, name:  ${buttonName}, command: ${buttonCommand}`);

							setTimeout(() => {
								const setChar = (state && this.power) ? buttonService.updateCharacteristic(Characteristic.On, false) : false;
							}, 300)
						} catch (error) {
							this.log.error(`Device: ${this.host} ${accessoryName}, set button error, name: ${buttonName}, error: ${error}`);
						};
					});
				accessory.addService(buttonService);
			}
		}

		this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
		const debug3 = this.enableDebugMode ? this.log(`Device: ${this.host} ${accessoryName}, published as external accessory.`) : false;
	}
};