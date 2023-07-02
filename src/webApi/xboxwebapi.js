'use strict';
const EventEmitter = require('events');
const Uuid4 = require('uuid4');

const Authentication = require('./authentication.js')
const HttpClient = require('./httpclient.js')
const Achievements = require('./providers/achievements.js');
const Catalog = require('./providers/catalog.js');
const Gameclips = require('./providers/gameclips.js');
const Messages = require('./providers/messages.js');
const People = require('./providers/people.js');
const Pins = require('./providers/pins.js');
const Screenshots = require('./providers/screenshots.js');
const Social = require('./providers/social.js');
const Titlehub = require('./providers/titlehub.js');
const UserPresence = require('./providers/userpresence.js');
const UserStats = require('./providers/userstats.js');
const CONSTANS = require('../constans.json');

class XBOXWEBAPI extends EventEmitter {
    constructor(config) {
        super();
        this.xboxLiveId = config.xboxLiveId;
        this.clientId = config.clientId;
        this.clientSecret = config.clientSecret;
        this.userToken = config.userToken;
        this.userHash = config.userHash;
        this.debugLog = config.debugLog;

        const authConfig = {
            xboxLiveUser: config.xboxLiveUser,
            xboxLivePasswd: config.xboxLivePasswd,
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            userToken: config.userToken,
            userHash: config.userHash,
            tokensFile: config.tokensFile
        }
        this.authentication = new Authentication(authConfig);
        this.httpClient = new HttpClient();

        //variables
        this.authorized = false;

        this.on('disconnected', async () => {
            await new Promise(resolve => setTimeout(resolve, 5000));
            this.emit('stateChanged', false);
        });

        this.getAuthorizationState();
    }

    async updateAuthorization() {
        await new Promise(resolve => setTimeout(resolve, 900000));
        this.getAuthorizationState();
    };

    async getAuthorizationState() {
        try {
            const tokens = this.userToken && this.userHash ? false : await this.authentication.checkAuthorization();
            const debug = this.debugLog ? this.emit('debug', `authorization tokens: ${JSON.stringify(tokens, null, 2)}`) : false;
            const authorizationHeaders = this.userToken && this.userHash ? `XBL3.0 x=${this.userHash};${this.userToken}` : `XBL3.0 x=${tokens.xsts.DisplayClaims.xui[0].uhs};${tokens.xsts.Token}`
            this.headers = {
                'Authorization': authorizationHeaders,
                'Accept-Language': 'en-US',
                'x-xbl-contract-version': '4',
                'x-xbl-client-name': 'XboxApp',
                'x-xbl-client-type': 'UWA',
                'x-xbl-client-version': '39.39.22001.0',
                'skillplatform': 'RemoteManagement'
            }
            this.tokens = tokens;
            this.authorized = true;

            try {
                const rmEnabled = await this.consoleStatus();
                const debug1 = !rmEnabled ? this.emit('message', `remote management not enabled, please check your console settings.`) : false;
                //await this.consolesList();
                await this.installedApps();
                //await this.storageDevices();
                //await this.userProfile();
                this.updateAuthorization();
            } catch (error) {
                this.emit('error', `web Api data error: ${JSON.stringify(error, null, 2)}, recheck in 15min.`)
                this.updateAuthorization();
            };
        } catch (error) {
            this.emit('error', `check authorization state error: ${JSON.stringify(error, null, 2)}, recheck in 15min.`);
            this.updateAuthorization();
        };
    };

    consoleStatus() {
        return new Promise(async (resolve, reject) => {
            try {
                const url = `https://xccs.xboxlive.com/consoles/${this.xboxLiveId}`;
                const getConsoleStatusData = await this.httpClient.get(url, this.headers);
                const responseObject = JSON.parse(getConsoleStatusData);
                const debug = this.debugLog ? this.emit('debug', `getConsoleStatusData, result: ${JSON.stringify(responseObject, null, 2)}`) : false

                if (responseObject.status.errorCode !== 'OK') {
                    reject(responseObject.status);
                    return;
                }

                //get console status
                const consoleStatusData = responseObject;
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
                const digitalAssistantRemoteControlEnabled = consoleStatusData.digitalAssistantRemoteControlEnabled;
                const consoleStreamingEnabled = consoleStatusData.consoleStreamingEnabled;
                const remoteManagementEnabled = consoleStatusData.remoteManagementEnabled;

                this.emit('consoleStatus', consoleStatusData, consoleType);
                resolve(remoteManagementEnabled);
            } catch (error) {
                reject(`Console: ${this.xboxLiveId}, get status error: ${error}`);
            };
        });
    }

    consolesList() {
        return new Promise(async (resolve, reject) => {
            try {
                const url = `https://xccs.xboxlive.com/lists/devices?queryCurrentDevice=false&includeStorageDevices=true`;
                const getConsolesListData = await this.httpClient.get(url, this.headers);
                const responseObject = JSON.parse(getConsolesListData);
                const debug = this.debugLog ? this.emit('debug', `getConsolesListData, result: ${responseObject.result[0]}, ${responseObject.result[0].storageDevices[0]}`) : false

                if (responseObject.status.errorCode !== 'OK') {
                    reject(responseObject.status);
                    return;
                }

                //get consoles list
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

                const consolesList = responseObject.result;
                for (const console of consolesList) {
                    const id = console.id;
                    const name = console.name;
                    const locale = console.locale;
                    const region = console.region;
                    const consoleType = console.consoleType;
                    const powerState = CONSTANS.ConsolePowerState[console.powerState]; // 0 - Off, 1 - On, 2 - ConnectedStandby, 3 - SystemUpdate
                    const digitalAssistantRemoteControlEnabled = console.digitalAssistantRemoteControlEnabled;
                    const remoteManagementEnabled = console.remoteManagementEnabled;
                    const consoleStreamingEnabled = console.consoleStreamingEnabled;
                    const wirelessWarning = console.wirelessWarning;
                    const outOfHomeWarning = console.outOfHomeWarning;

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

                this.emit('consolesList', consolesList);
                resolve();
            } catch (error) {
                reject(`Consoles list error: ${error}`);
            };
        });
    }

    installedApps() {
        return new Promise(async (resolve, reject) => {
            try {
                const url = `https://xccs.xboxlive.com/lists/installedApps?deviceId=${this.xboxLiveId}`;
                const getInstalledAppsData = await this.httpClient.get(url, this.headers);
                const responseObject = JSON.parse(getInstalledAppsData);
                const debug = this.debugLog ? this.emit('debug', `getInstalledAppsData: ${JSON.stringify(responseObject.result, null, 2)}`) : false

                if (responseObject.status.errorCode !== 'OK') {
                    reject(responseObject.status);
                    return;
                }

                //get installed apps
                const appsArray = [];
                const apps = responseObject.result;
                for (const app of apps) {
                    const oneStoreProductId = app.oneStoreProductId;
                    const titleId = app.titleId;
                    const aumid = app.aumid;
                    const lastActiveTime = app.lastActiveTime;
                    const isGame = app.isGame;
                    const name = app.name;
                    const contentType = app.contentType;
                    const instanceId = app.instanceId;
                    const storageDeviceId = app.storageDeviceId;
                    const uniqueId = app.uniqueId;
                    const legacyProductId = app.legacyProductId;
                    const version = app.version;
                    const sizeInBytes = app.sizeInBytes;
                    const installTime = app.installTime;
                    const updateTime = app.updateTime;
                    const parentId = app.parentId;

                    const inputsObj = {
                        'oneStoreProductId': oneStoreProductId,
                        'titleId': titleId,
                        'reference': aumid,
                        'isGame': isGame,
                        'name': name,
                        'contentType': contentType
                    };
                    appsArray.push(inputsObj);
                };

                this.emit('appsList', appsArray);
                resolve();
            } catch (error) {
                reject(`Console: ${this.xboxLiveId}, get installed apps error: ${error}`);
            };
        });
    }

    storageDevices() {
        return new Promise(async (resolve, reject) => {
            try {
                const url = `https://xccs.xboxlive.com/lists/storageDevices?deviceId=${this.xboxLiveId}`;
                const getStorageDevicesData = await this.httpClient.get(url, this.headers);
                const responseObject = JSON.parse(getStorageDevicesData);
                const debug = this.debugLog ? this.emit('debug', `getStorageDevicesData, result: ${JSON.stringify(responseObject, null, 2)}`) : false

                if (responseObject.status.errorCode !== 'OK') {
                    reject(responseObject.status);
                    return;
                }

                //get console storages
                this.storageDeviceId = [];
                this.storageDeviceName = [];
                this.isDefault = [];
                this.freeSpaceBytes = [];
                this.totalSpaceBytes = [];
                this.isGen9Compatible = [];

                const storageDevices = responseObject.result;
                const deviceId = responseObject.deviceId;
                const agentUserId = responseObject.agentUserId;
                for (const storageDevice of storageDevices) {
                    const storageDeviceId = storageDevice.storageDeviceId;
                    const storageDeviceName = storageDevice.storageDeviceName;
                    const isDefault = storageDevice.isDefault;
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

                this.emit('storageDevices', storageDevices);
                resolve();
            } catch (error) {
                reject(`Console: ${this.xboxLiveId}, get storage devices error: ${error}`);
            };
        });
    }

    userProfile() {
        return new Promise(async (resolve, reject) => {
            try {
                const url = `https://profile.xboxlive.com/users/xuid(${this.tokens.xsts.DisplayClaims.xui[0].xid})/profile/settings?settings=GameDisplayName,GameDisplayPicRaw,Gamerscore,Gamertag`;
                const getUserProfileData = await this.httpClient.get(url, this.headers);
                const responseObject = JSON.parse(getUserProfileData);
                const debug = this.debugLog ? this.emit('debug', `getUserProfileData, result: ${JSON.stringify(responseObject.profileUsers[0], null, 2)}, ${JSON.stringify(responseObject.profileUsers[0].settings[0], null, 2)}`) : false

                if (responseObject.status.errorCode !== 'OK') {
                    reject(responseObject.status);
                    return;
                }

                //get user profiles
                this.userProfileId = [];
                this.userProfileHostId = [];
                this.userProfileIsSponsoredUser = [];
                this.userProfileSettingsId = [];
                this.userProfileSettingsValue = [];

                const profileUsers = responseObject.profileUsers;
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

                this.emit('userProfile', profileUsers);
                resolve();
            } catch (error) {
                reject(`User profile error: ${error}`);
            };
        });
    }

    powerOn() {
        return new Promise(async (resolve, reject) => {
            try {
                await this.send('Power', 'WakeUp')
                resolve();
            } catch (error) {
                this.emit('powerOnError', false);
                reject(error);
            };
        });
    }

    powerOff() {
        return new Promise(async (resolve, reject) => {
            try {
                await this.send('Power', 'TurnOff')
                resolve();
            } catch (error) {
                reject(error);
            };
        });
    }

    reboot() {
        return new Promise(async (resolve, reject) => {
            try {
                await this.send('Power', 'Reboot')
                resolve();
            } catch (error) {
                reject(error);
            };
        });
    }

    mute() {
        return new Promise(async (resolve, reject) => {
            try {
                await this.send('Audio', 'Mute')
                resolve();
            } catch (error) {
                reject(error);
            };
        });
    }

    unmute() {
        return new Promise(async (resolve, reject) => {
            try {
                await this.send('Audio', 'Unmute')
                resolve();
            } catch (error) {
                reject(error);
            };
        });
    }

    volumeUp() {
        return new Promise(async (resolve, reject) => {
            try {
                await this.send('Volume', 'Up')
                resolve();
            } catch (error) {
                reject(error);
            };
        });
    }

    volumeDown() {
        return new Promise(async (resolve, reject) => {
            try {
                await this.send('Volume', 'Dovn')
                resolve();
            } catch (error) {
                reject(error);
            };
        });
    }

    next() {
        return new Promise(async (resolve, reject) => {
            try {
                await this.send('Media', 'Next')
                resolve();
            } catch (error) {
                reject(error);
            };
        });
    }

    previous() {
        return new Promise(async (resolve, reject) => {
            try {
                await this.send('Media', 'Previous')
                resolve();
            } catch (error) {
                reject(error);
            };
        });
    }

    pause() {
        return new Promise(async (resolve, reject) => {
            try {
                await this.send('Media', 'Pause')
                resolve();
            } catch (error) {
                reject(error);
            };
        });
    }

    play() {
        return new Promise(async (resolve, reject) => {
            try {
                await this.send('Media', 'Play')
                resolve();
            } catch (error) {
                reject(error);
            };
        });
    }

    goBack() {
        return new Promise(async (resolve, reject) => {
            try {
                await this.send('Shell', 'GoBack')
                resolve();
            } catch (error) {
                reject(error);
            };
        });
    }


    goHome() {
        return new Promise(async (resolve, reject) => {
            try {
                await this.send('Shell', 'GoHome')
                resolve();
            } catch (error) {
                reject(error);
            };
        });
    }

    launchApp(oneStoreProductId) {
        return new Promise(async (resolve, reject) => {
            try {
                await this.send('Shell', 'ActivateApplicationWithOneStoreProductId', [{
                    'oneStoreProductId': oneStoreProductId
                }])
                resolve();
            } catch (error) {
                reject(error);
            };
        });
    }

    showGuideTab() {
        return new Promise(async (resolve, reject) => {
            try {
                await this.send('Shell', 'ShowGuideTab', [{
                    'tabName': 'Guide'
                }])
                resolve();
            } catch (error) {
                reject(error);
            };
        });
    }

    showTVGuide() {
        return new Promise(async (resolve, reject) => {
            try {
                await this.send('TV', 'ShowGuide')
                resolve();
            } catch (error) {
                reject(error);
            };
        });
    }

    sendButtonPress(button) {
        return new Promise(async (resolve, reject) => {
            try {
                await this.send('Shell', 'InjectKey', [{
                    'keyType': button
                }])
                resolve();
            } catch (error) {
                reject(error);
            };
        });
    }

    send(commandType, command, payload) {
        return new Promise(async (resolve, reject) => {
            if (!this.authorized) {
                reject('not authorized.');
                return;
            };

            try {
                const sessionid = Uuid4();
                const params = payload ? payload : [];
                const postParams = {
                    "destination": "Xbox",
                    "type": commandType,
                    "command": command,
                    "sessionId": sessionid,
                    "sourceId": "com.microsoft.smartglass",
                    "parameters": params,
                    "linkedXboxId": this.xboxLiveId,
                }

                const url = `https://xccs.xboxlive.com/commands`;
                const postData = JSON.stringify(postParams);
                await this.httpClient.post(url, this.headers, postData);
                resolve();
            } catch (error) {
                reject(`send command type: ${commandType}, command: ${command}, params: ${payload}, error: ${JSON.stringify(error)}`);
            };
        });
    }
}
module.exports = XBOXWEBAPI;