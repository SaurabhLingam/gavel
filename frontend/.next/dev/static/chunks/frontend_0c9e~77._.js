(globalThis["TURBOPACK"] || (globalThis["TURBOPACK"] = [])).push([typeof document === "object" ? document.currentScript : undefined,
"[project]/frontend/lib/api.ts [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "adminAPI",
    ()=>adminAPI,
    "analyticsAPI",
    ()=>analyticsAPI,
    "auctionAPI",
    ()=>auctionAPI,
    "authAPI",
    ()=>authAPI,
    "bidAPI",
    ()=>bidAPI,
    "fetchAPI",
    ()=>fetchAPI,
    "userAPI",
    ()=>userAPI
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$build$2f$polyfills$2f$process$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = /*#__PURE__*/ __turbopack_context__.i("[project]/frontend/node_modules/next/dist/build/polyfills/process.js [app-client] (ecmascript)");
// API utility functions for communicating with the Express backend
const API_BASE = (__TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$build$2f$polyfills$2f$process$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"].env.NEXT_PUBLIC_API_URL || '').replace(/\/$/, '');
function buildApiUrl(endpoint) {
    return API_BASE ? `${API_BASE}${endpoint}` : endpoint;
}
async function fetchAPI(endpoint, options = {}) {
    const url = buildApiUrl(endpoint);
    const defaultOptions = {
        credentials: 'include',
        headers: {
            'Content-Type': 'application/json',
            ...options.headers
        },
        ...options
    };
    const response = await fetch(url, defaultOptions);
    if (!response.ok) {
        const error = await response.json().catch(()=>({
                message: 'An error occurred'
            }));
        throw new Error(error.message || error.error || 'API request failed');
    }
    return response.json();
}
const authAPI = {
    register: (data)=>fetchAPI('/api/auth/register', {
            method: 'POST',
            body: JSON.stringify(data)
        }),
    login: (data)=>fetchAPI('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify(data)
        }),
    logout: ()=>fetchAPI('/api/logout', {
            method: 'POST'
        }),
    me: ()=>fetchAPI('/api/auth/me'),
    getConfig: ()=>fetchAPI('/api/config')
};
const auctionAPI = {
    getAll: ()=>fetchAPI('/api/auctions'),
    getById: (id)=>fetchAPI(`/api/auction/${id}`),
    getClosed: ()=>fetchAPI('/api/auctions/closed'),
    create: (formData)=>fetch(buildApiUrl('/api/sell'), {
            method: 'POST',
            credentials: 'include',
            body: formData
        }).then((res)=>{
            if (!res.ok) throw new Error('Failed to create auction');
            return res.json();
        })
};
const bidAPI = {
    placeBid: (listingId, bidAmount)=>fetchAPI(`/api/bids/${listingId}`, {
            method: 'POST',
            body: JSON.stringify({
                bidAmount
            })
        }),
    setAutoBid: (listingId, maxAmount)=>fetchAPI('/api/bids/auto-bid', {
            method: 'POST',
            body: JSON.stringify({
                listingId,
                maxAmount
            })
        })
};
const userAPI = {
    deposit: (amount)=>fetchAPI('/api/deposit', {
            method: 'POST',
            body: JSON.stringify({
                amount
            })
        })
};
const adminAPI = {
    getUsers: ()=>fetchAPI('/api/admin/users'),
    getLogs: ()=>fetchAPI('/api/admin/logs'),
    deleteUser: (id)=>fetchAPI(`/api/admin/users/${id}`, {
            method: 'DELETE'
        }),
    deleteAuction: (id)=>fetchAPI(`/api/admin/auctions/${id}`, {
            method: 'DELETE'
        })
};
const analyticsAPI = {
    getStats: ()=>fetchAPI('/api/analytics')
};
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/frontend/contexts/AuthContext.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "AuthProvider",
    ()=>AuthProvider,
    "useAuth",
    ()=>useAuth
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$lib$2f$api$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/lib/api.ts [app-client] (ecmascript)");
;
var _s = __turbopack_context__.k.signature(), _s1 = __turbopack_context__.k.signature();
'use client';
;
;
const AuthContext = /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["createContext"])(undefined);
function AuthProvider({ children }) {
    _s();
    const [user, setUser] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    const [loading, setLoading] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(true);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "AuthProvider.useEffect": ()=>{
            refreshUser();
        }
    }["AuthProvider.useEffect"], []);
    const refreshUser = async ()=>{
        try {
            const data = await __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$lib$2f$api$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["authAPI"].me();
            setUser(data);
        } catch (error) {
            setUser(null);
        } finally{
            setLoading(false);
        }
    };
    const login = async (email, password)=>{
        const data = await __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$lib$2f$api$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["authAPI"].login({
            email,
            password
        });
        if (data.success) {
            await refreshUser();
        }
    };
    const register = async (fullname, email, password, college)=>{
        const data = await __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$lib$2f$api$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["authAPI"].register({
            fullname,
            email,
            password,
            college
        });
        if (data.success) {
            await refreshUser();
        }
    };
    const logout = async ()=>{
        await __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$lib$2f$api$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["authAPI"].logout().catch(()=>undefined);
        clearClientAuthState();
        setUser(null);
    };
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(AuthContext.Provider, {
        value: {
            user,
            loading,
            login,
            register,
            logout,
            refreshUser
        },
        children: children
    }, void 0, false, {
        fileName: "[project]/frontend/contexts/AuthContext.tsx",
        lineNumber: 67,
        columnNumber: 5
    }, this);
}
_s(AuthProvider, "NiO5z6JIqzX62LS5UWDgIqbZYyY=");
_c = AuthProvider;
function useAuth() {
    _s1();
    const context = (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useContext"])(AuthContext);
    if (context === undefined) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
}
_s1(useAuth, "b9L3QQ+jgeyIrH0NfHrJ8nn7VMU=");
function clearClientAuthState() {
    if ("TURBOPACK compile-time falsy", 0) //TURBOPACK unreachable
    ;
    const clearStore = (store)=>{
        const keysToRemove = [];
        for(let i = 0; i < store.length; i += 1){
            const key = store.key(i);
            if (!key) continue;
            if (key.includes('supabase') || key.includes('sb-')) {
                keysToRemove.push(key);
            }
        }
        keysToRemove.forEach((key)=>store.removeItem(key));
    };
    try {
        clearStore(window.localStorage);
        clearStore(window.sessionStorage);
    } catch (error) {
        console.warn('Failed to clear auth storage', error);
    }
    document.cookie = 'sb_access_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax';
    document.cookie = 'jwt_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax';
}
var _c;
__turbopack_context__.k.register(_c, "AuthProvider");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
]);

//# sourceMappingURL=frontend_0c9e~77._.js.map