// Backpack交易所公共API库
// 集成REST API和WebSocket API功能

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

// 配置
const config = {
    baseUrl: 'https://api.backpack.exchange/',
    wsUrl: 'wss://ws.backpack.exchange',
    logEnabled: true,
    defaultWindow: 5000 // 默认时间窗口（毫秒）
};

// 日志函数
function log(message, isError = false) {
    const timestamp = new Date().toLocaleString();
    const logMessage = `[${timestamp}] ${message}`;
    
    if (config.logEnabled) {
        console.log(logMessage);
    }
    
    // 写入日志文件
    const logDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }
    
    const date = new Date().toISOString().split('T')[0];
    const logFile = path.join(logDir, `backpack_api_${date}.log`);
    
    fs.appendFileSync(
        logFile, 
        logMessage + '\n', 
        { encoding: 'utf8' }
    );
    
    if (isError) {
        const errorLogFile = path.join(logDir, `backpack_api_error_${date}.log`);
        fs.appendFileSync(errorLogFile, logMessage + '\n', { encoding: 'utf8' });
    }
}

// 枚举类型 - 时间间隔
const TimeIntervalEnum = {
    ONE_MINUTE: '1m',
    THREE_MINUTES: '3m',
    FIVE_MINUTES: '5m',
    FIFTEEN_MINUTES: '15m',
    THIRTY_MINUTES: '30m',
    ONE_HOUR: '1h',
    TWO_HOURS: '2h',
    FOUR_HOURS: '4h',
    SIX_HOURS: '6h',
    EIGHT_HOURS: '8h',
    TWELVE_HOURS: '12h',
    ONE_DAY: '1d',
    THREE_DAYS: '3d',
    ONE_WEEK: '1w',
    ONE_MONTH: '1M',
    
    // 验证值是否有效
    hasValue(interval) {
        return Object.values(this).includes(interval);
    }
};

// 枚举类型 - 借贷市场历史时间间隔
const BorrowLendMarketHistoryIntervalEnum = {
    ONE_DAY: '1d',
    SEVEN_DAYS: '7d',
    FOURTEEN_DAYS: '14d',
    THIRTY_DAYS: '30d',
    NINETY_DAYS: '90d',
    
    // 验证值是否有效
    hasValue(interval) {
        return Object.values(this).includes(interval);
    }
};

// 订单类型枚举
const OrderTypeEnum = {
    LIMIT: 'Limit',
    MARKET: 'Market',
    STOP_LIMIT: 'StopLimit',
    STOP_MARKET: 'StopMarket',
    
    // 验证值是否有效
    hasValue(type) {
        return Object.values(this).includes(type);
    }
};

// 订单方向枚举
const OrderSideEnum = {
    BUY: 'Bid',
    SELL: 'Ask',
    
    // 验证值是否有效
    hasValue(side) {
        return Object.values(this).includes(side);
    }
};

// 时效类型枚举
const TimeInForceEnum = {
    GTC: 'GoodTilCancelled',
    IOC: 'ImmediateOrCancel',
    FOK: 'FillOrKill',
    
    // 验证值是否有效
    hasValue(timeInForce) {
        return Object.values(this).includes(timeInForce);
    }
};

/**
 * Backpack公共API类
 */
class BackpackPublicApi {
    constructor() {
        this.baseUrl = config.baseUrl;
        this.wsUrl = config.wsUrl;
    }
    
    /**
     * 构建端点URL
     * @param {string} path - API路径
     * @returns {string} 完整URL
     */
    _endpoint(path) {
        return `${this.baseUrl}${path}`;
    }
    
    /**
     * 发送API请求并返回响应
     * @param {string} url - 请求URL
     * @param {string} method - HTTP方法
     * @param {object} data - 请求数据
     * @param {object} headers - 请求头
     * @returns {Promise} 响应数据
     */
    async _request(url, method = 'GET', data = null, headers = {}) {
        try {
            log(`发送${method}请求: ${url}`);
            
            const defaultHeaders = {
                'Content-Type': 'application/json'
            };
            
            const response = await axios({
                method,
                url,
                data: method !== 'GET' ? data : null,
                params: method === 'GET' && data ? data : null,
                headers: { ...defaultHeaders, ...headers }
            });
            
            log(`请求成功: ${url}`);
            return response.data;
        } catch (error) {
            const errorMessage = error.response 
                ? `${error.response.status}: ${JSON.stringify(error.response.data)}` 
                : error.message;
                
            log(`请求失败: ${url}, 错误: ${errorMessage}`, true);
            throw error;
        }
    }
    
    // ======= 资产相关 API =======
    
    /**
     * 获取所有资产信息
     */
    async getAssets() {
        const url = this._endpoint('api/v1/assets');
        return this._request(url);
    }
    
    /**
     * 获取抵押品信息
     */
    async getCollateral() {
        const url = this._endpoint('api/v1/collateral');
        return this._request(url);
    }
    
    // ======= 借贷市场相关 API =======
    
    /**
     * 获取借贷市场信息
     */
    async getBorrowLendMarkets() {
        const url = this._endpoint('api/v1/borrowLend/markets');
        return this._request(url);
    }
    
    /**
     * 获取借贷市场历史
     * @param {string} interval - 时间间隔
     * @param {string} symbol - 交易对(可选)
     */
    async getBorrowLendMarketHistory(interval, symbol = null) {
        if (!BorrowLendMarketHistoryIntervalEnum.hasValue(interval)) {
            throw new Error(`无效的时间间隔: ${interval}`);
        }
        
        let url = `api/v1/borrowLend/markets/history?interval=${interval}`;
        if (symbol) {
            url += `&symbol=${symbol}`;
        }
        
        return this._request(this._endpoint(url));
    }
    
    // ======= 市场相关 API =======
    
    /**
     * 获取所有市场信息
     */
    async getMarkets() {
        const url = this._endpoint('api/v1/markets');
        return this._request(url);
    }
    
    /**
     * 获取指定市场信息
     * @param {string} symbol - 交易对
     */
    async getMarket(symbol) {
        const url = this._endpoint(`api/v1/markets/${symbol}`);
        return this._request(url);
    }
    
    /**
     * 获取指定市场的行情信息
     * @param {string} symbol - 交易对
     */
    async getTicker(symbol) {
        const url = this._endpoint(`api/v1/ticker?symbol=${symbol}`);
        return this._request(url);
    }
    
    /**
     * 获取所有市场的行情信息
     */
    async getTickers() {
        const url = this._endpoint('api/v1/tickers');
        return this._request(url);
    }
    
    /**
     * 获取指定市场的深度信息
     * @param {string} symbol - 交易对
     */
    async getDepth(symbol) {
        const url = this._endpoint(`api/v1/depth?symbol=${symbol}`);
        return this._request(url);
    }
    
    /**
     * 获取K线数据
     * @param {string} symbol - 交易对
     * @param {string} interval - 时间间隔
     * @param {number} startTime - 开始时间(毫秒)
     * @param {number} endTime - 结束时间(毫秒)(可选)
     */
    async getKlines(symbol, interval, startTime, endTime = null) {
        if (startTime < 0) {
            throw new Error('startTime不能为负数');
        }
        
        if (!TimeIntervalEnum.hasValue(interval)) {
            throw new Error(`无效的时间间隔: ${interval}`);
        }
        
        let url = `api/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}`;
        if (endTime) {
            url += `&endTime=${endTime}`;
        }
        
        return this._request(this._endpoint(url));
    }
    
    /**
     * 获取所有标记价格
     * @param {string} symbol - 交易对(可选)
     */
    async getAllMarkPrices(symbol = null) {
        let url = 'api/v1/markPrices';
        if (symbol) {
            url += `?symbol=${symbol}`;
        }
        
        return this._request(this._endpoint(url));
    }
    
    /**
     * 获取指定市场的未平仓合约数量
     * @param {string} symbol - 交易对
     */
    async getOpenInterest(symbol) {
        const url = this._endpoint(`api/v1/openInterest?symbol=${symbol}`);
        return this._request(url);
    }
    
    /**
     * 获取资金费率
     * @param {string} symbol - 交易对
     * @param {number} limit - 限制返回数量(默认1000)
     * @param {number} offset - 偏移量(默认0)
     */
    async getFundingIntervalRates(symbol, limit = 1000, offset = 0) {
        if (limit < 0 || limit > 1000) {
            throw new Error('limit必须在0-1000之间');
        }
        
        if (offset < 0) {
            throw new Error('offset不能为负数');
        }
        
        const url = this._endpoint(`api/v1/fundingRates?symbol=${symbol}&limit=${limit}&offset=${offset}`);
        return this._request(url);
    }
    
    // ======= 系统相关 API =======
    
    /**
     * 获取系统状态
     */
    async getStatus() {
        const url = this._endpoint('api/v1/status');
        return this._request(url);
    }
    
    /**
     * Ping测试
     */
    async ping() {
        const url = this._endpoint('api/v1/ping');
        return this._request(url);
    }
    
    /**
     * 获取服务器时间
     */
    async getTime() {
        const url = this._endpoint('api/v1/time');
        return this._request(url);
    }
    
    // ======= 交易相关 API =======
    
    /**
     * 获取最近交易
     * @param {string} symbol - 交易对
     * @param {number} limit - 限制返回数量(默认100)
     */
    async getRecentTrades(symbol, limit = 100) {
        if (limit < 0 || limit > 1000) {
            throw new Error('limit必须在0-1000之间');
        }
        
        const url = this._endpoint(`api/v1/trades?symbol=${symbol}&limit=${limit}`);
        return this._request(url);
    }
    
    /**
     * 获取历史交易
     * @param {string} symbol - 交易对
     * @param {number} limit - 限制返回数量(默认100)
     * @param {number} offset - 偏移量(默认0)
     */
    async getHistoricalTrades(symbol, limit = 100, offset = 0) {
        if (limit < 0 || limit > 1000) {
            throw new Error('limit必须在0-1000之间');
        }
        
        if (offset < 0) {
            throw new Error('offset不能为负数');
        }
        
        const url = this._endpoint(`api/v1/trades/history?symbol=${symbol}&limit=${limit}&offset=${offset}`);
        return this._request(url);
    }
    
    // ======= WebSocket相关方法 =======
    
    /**
     * 创建公共WebSocket连接
     * @param {string} symbol - 交易对(例如 BTC_USDC)
     * @param {function} messageCallback - 消息回调函数
     * @returns {WebSocket} WebSocket连接
     */
    createPublicWebSocket(symbol, messageCallback) {
        try {
            log(`创建公共WebSocket连接，交易对: ${symbol}`);
            
            // 连接到Backpack WebSocket API
            const ws = new WebSocket(this.wsUrl);
            
            // WebSocket打开时
            ws.onopen = () => {
                log('公共WebSocket连接已建立');
                
                // 订阅ticker数据
                const subscriptionData = {
                    method: "SUBSCRIBE",
                    params: [`ticker.${symbol}`],
                    id: Date.now()
                };
                log(`订阅ticker数据: ${JSON.stringify(subscriptionData)}`);
                ws.send(JSON.stringify(subscriptionData));
                
                // 设置心跳
                this._setupHeartbeat(ws);
            };
            
            // 处理接收到的消息
            ws.onmessage = (event) => {
                try {
                    log(`收到WebSocket消息: ${event.data}`);
                    if (messageCallback) {
                        messageCallback(event.data);
                    }
                } catch (error) {
                    log(`WebSocket消息处理错误: ${error.message}`, true);
                }
            };
            
            // 处理错误
            ws.onerror = (error) => {
                log(`WebSocket错误: ${error.message || '未知错误'}`, true);
            };
            
            // 连接关闭时
            ws.onclose = (event) => {
                log(`WebSocket连接已关闭，代码: ${event.code}, 原因: ${event.reason}`);
            };
            
            return ws;
        } catch (error) {
            log(`创建WebSocket连接时出错: ${error.message}`, true);
            return null;
        }
    }
    
    /**
     * 设置WebSocket心跳
     * @param {WebSocket} ws - WebSocket连接
     * @private
     */
    _setupHeartbeat(ws) {
        const heartbeatInterval = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                try {
                    const heartbeatMsg = JSON.stringify({
                        method: "PING",
                        id: Date.now()
                    });
                    
                    ws.send(heartbeatMsg);
                    log(`WebSocket发送心跳: ${heartbeatMsg}`);
                } catch (error) {
                    log(`发送心跳时出错: ${error.message}`, true);
                    clearInterval(heartbeatInterval);
                }
            } else {
                clearInterval(heartbeatInterval);
            }
        }, 20000); // 每20秒发送一次心跳
        
        return heartbeatInterval;
    }
    
    /**
     * 关闭WebSocket连接
     * @param {WebSocket} ws - WebSocket连接
     */
    closeWebSocket(ws) {
        if (ws) {
            try {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.close();
                    log('WebSocket连接已关闭');
                }
            } catch (error) {
                log(`关闭WebSocket时出错: ${error.message}`, true);
            }
        }
    }
}

/**
 * Backpack账户API类 - 继承自公共API
 */
class BackpackAccountApi extends BackpackPublicApi {
    /**
     * 构造函数
     * @param {string} apiKey - API密钥
     * @param {string} secretKey - API密钥
     * @param {number} window - 时间窗口(毫秒)
     */
    constructor(apiKey, secretKey, window = 5000) {
        super();
        this.apiKey = apiKey;
        this.secretKey = secretKey;
        this.window = window;
    }
    
    /**
     * 解码私钥成pkcs8编码的私钥
     * @param {string} rawB64 - Base64编码的私钥
     * @private
     */
    _toPkcs8der(rawB64) {
        try {
            // 移除可能的空格和换行符
            rawB64 = rawB64.trim().replace(/\s+/g, '');
            
            // 检查私钥格式
            if (!rawB64.startsWith('sd')) {
                throw new Error('私钥格式错误：必须以sd开头');
            }
            
            // 解码base64
            const rawPrivate = Buffer.from(rawB64, "base64");
            if (rawPrivate.length < 32) {
                throw new Error('私钥长度不足');
            }
            
            // 只取前32字节
            const privateKeyBytes = rawPrivate.subarray(0, 32);
            
            // 添加ED25519私钥前缀
            const prefixPrivateEd25519 = Buffer.from("302e020100300506032b657004220420", "hex");
            const der = Buffer.concat([prefixPrivateEd25519, privateKeyBytes]);
            
            return crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
        } catch (error) {
            throw new Error(`私钥处理错误: ${error.message}`);
        }
    }
    
    /**
     * 生成签名 - 参考base_account.py的_sign方法
     * @param {object} params - 请求参数
     * @param {string} instruction - 指令类型
     * @param {number} timestamp - 时间戳
     * @param {number} window - 时间窗口
     * @returns {string} Base64编码的签名
     * @private
     */
    _sign(params, instruction, timestamp, window) {
        // 构建签名字符串
        let signStr = `instruction=${instruction}`;
        
        // 按字母顺序排序参数
        const sortedParamsList = [];
        for (const [key, value] of Object.entries(params).sort()) {
            let paramValue = value;
            if (typeof paramValue === 'boolean') {
                paramValue = paramValue.toString().toLowerCase();
            }
            sortedParamsList.push(`${key}=${paramValue}`);
        }
        
        if (sortedParamsList.length > 0) {
            signStr += '&' + sortedParamsList.join('&');
        }
        
        signStr += `&timestamp=${timestamp}&window=${window}`;
        
        log(`签名字符串: ${signStr}`);
        
        // 使用私钥签名
        try {
            const signature = crypto.sign(
                null, 
                Buffer.from(signStr), 
                this._toPkcs8der(this.secretKey)
            );
            
            return signature.toString("base64");
        } catch (error) {
            log(`签名生成错误: ${error.message}`, true);
            throw error;
        }
    }
    
    /**
     * 创建headers - 参考base_account.py的_headers方法
     * @param {object} params - 请求参数
     * @param {string} instruction - 指令类型
     * @param {number} window - 时间窗口
     * @returns {object} 请求头
     * @private
     */
    _headers(params, instruction, window = null) {
        window = window || this.window;
        const timestamp = Date.now();
        const signature = this._sign(params, instruction, timestamp, window);
        
        return {
            'X-API-Key': this.apiKey,
            'X-Signature': signature,
            'X-Timestamp': timestamp.toString(),
            'X-Window': window.toString(),
            'Content-Type': 'application/json; charset=utf-8'
        };
    }
    
    /**
     * 获取账户信息
     */
    async getAccount() {
        const params = {};
        const headers = this._headers(params, "accountQuery");
        const url = this._endpoint("api/v1/account");
        
        return this._request(url, 'GET', null, headers);
    }
    
    /**
     * 获取账户余额
     */
    async getBalances() {
        const params = {};
        const headers = this._headers(params, "balanceQuery");
        const url = this._endpoint("api/v1/capital");
        
        return this._request(url, 'GET', null, headers);
    }
    
    /**
     * 创建订单
     * @param {string} symbol - 交易对
     * @param {string} side - 订单方向(Bid/Ask)
     * @param {string} orderType - 订单类型(Limit/Market)
     * @param {string} quantity - 数量
     * @param {string} price - 价格(限价单必填)
     * @param {string} timeInForce - 时效类型
     * @returns {Promise} 订单响应
     */
    async createOrder(symbol, side, orderType, quantity, price = null, timeInForce = 'GoodTilCancelled') {
        if (!OrderSideEnum.hasValue(side)) {
            throw new Error(`无效的订单方向: ${side}`);
        }
        
        if (!OrderTypeEnum.hasValue(orderType)) {
            throw new Error(`无效的订单类型: ${orderType}`);
        }
        
        if (orderType === OrderTypeEnum.LIMIT && !price) {
            throw new Error('限价单必须指定价格');
        }
        
        if (!TimeInForceEnum.hasValue(timeInForce)) {
            throw new Error(`无效的时效类型: ${timeInForce}`);
        }
        
        const params = {
            symbol,
            side,
            orderType,
            quantity
        };
        
        if (price) {
            params.price = price;
        }
        
        params.timeInForce = timeInForce;
        
        const headers = this._headers(params, "orderExecute");
        const url = this._endpoint("api/v1/order");
        
        return this._request(url, 'POST', params, headers);
    }
    
    /**
     * 取消订单
     * @param {string} symbol - 交易对
     * @param {string} orderId - 订单ID
     */
    async cancelOrder(symbol, orderId) {
        const params = {
            symbol,
            orderId
        };
        
        const headers = this._headers(params, "orderCancel");
        const url = this._endpoint("api/v1/order");
        
        return this._request(url, 'DELETE', params, headers);
    }
    
    /**
     * 获取未完成订单
     * @param {string} symbol - 交易对
     */
    async getOpenOrders(symbol) {
        const params = { symbol };
        const headers = this._headers(params, "orderQueryAll");
        const url = this._endpoint("api/v1/orders");
        
        return this._request(url, 'GET', params, headers);
    }
    
    /**
     * 取消所有订单
     * @param {string} symbol - 交易对
     */
    async cancelAllOrders(symbol) {
        const params = { symbol };
        const headers = this._headers(params, "orderCancelAll");
        const url = this._endpoint("api/v1/orders");
        
        return this._request(url, 'DELETE', params, headers);
    }
    
    /**
     * 创建私有WebSocket连接
     * @param {function} messageCallback - 消息回调函数
     * @returns {WebSocket} WebSocket连接
     */
    createPrivateWebSocket(messageCallback) {
        try {
            log(`创建私有WebSocket连接...`);
            
            // 连接到Backpack WebSocket API
            const ws = new WebSocket(this.wsUrl);
            
            // WebSocket打开时
            ws.onopen = () => {
                log('私有WebSocket连接已建立');
                
                // 订阅订单更新
                this._subscribeToOrderUpdates(ws);
                
                // 设置心跳
                this._setupHeartbeat(ws);
            };
            
            // 处理接收到的消息
            ws.onmessage = (event) => {
                try {
                    log(`收到WebSocket消息: ${event.data}`);
                    if (messageCallback) {
                        messageCallback(event.data);
                    }
                } catch (error) {
                    log(`WebSocket消息处理错误: ${error.message}`, true);
                }
            };
            
            // 处理错误
            ws.onerror = (error) => {
                log(`WebSocket错误: ${error.message || '未知错误'}`, true);
            };
            
            // 连接关闭时
            ws.onclose = (event) => {
                log(`WebSocket连接已关闭，代码: ${event.code}, 原因: ${event.reason}`);
            };
            
            return ws;
        } catch (error) {
            log(`创建WebSocket连接时出错: ${error.message}`, true);
            return null;
        }
    }
    
    /**
     * 订阅订单更新
     * @param {WebSocket} ws - WebSocket连接
     * @private
     */
    _subscribeToOrderUpdates(ws) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        
        try {
            const timestamp = Date.now();
            const window = this.window;
            const signature = this._sign({}, "subscribe", timestamp, window);
            
            // 根据文档构建正确的签名数组
            const subscriptionData = {
                method: "SUBSCRIBE",
                params: ["account.orderUpdate"],
                signature: [
                    this.apiKey, 
                    signature, 
                    timestamp.toString(), 
                    window.toString()
                ]
            };
            
            log(`发送订单更新订阅请求: ${JSON.stringify(subscriptionData)}`);
            ws.send(JSON.stringify(subscriptionData));
        } catch (error) {
            log(`发送订阅请求时出错: ${error.message}`, true);
        }
    }
}

// 导出模块
module.exports = {
    BackpackPublicApi,
    BackpackAccountApi,
    TimeIntervalEnum,
    OrderTypeEnum,
    OrderSideEnum,
    TimeInForceEnum,
    BorrowLendMarketHistoryIntervalEnum,
    log
}; 