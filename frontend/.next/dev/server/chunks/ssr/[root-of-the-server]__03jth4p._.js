module.exports = [
"[externals]/next/dist/compiled/next-server/app-page-turbo.runtime.dev.js [external] (next/dist/compiled/next-server/app-page-turbo.runtime.dev.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/compiled/next-server/app-page-turbo.runtime.dev.js", () => require("next/dist/compiled/next-server/app-page-turbo.runtime.dev.js"));

module.exports = mod;
}),
"[project]/frontend/lib/api.ts [app-ssr] (ecmascript)", ((__turbopack_context__) => {
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
// API utility functions for communicating with the Express backend
const API_BASE = (process.env.NEXT_PUBLIC_API_URL || '').replace(/\/$/, '');
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
}),
"[project]/frontend/contexts/AuthContext.tsx [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "AuthProvider",
    ()=>AuthProvider,
    "useAuth",
    ()=>useAuth
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/next/dist/server/route-modules/app-page/vendored/ssr/react-jsx-dev-runtime.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/next/dist/server/route-modules/app-page/vendored/ssr/react.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$lib$2f$api$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/lib/api.ts [app-ssr] (ecmascript)");
'use client';
;
;
;
const AuthContext = /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["createContext"])(undefined);
function AuthProvider({ children }) {
    const [user, setUser] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["useState"])(null);
    const [loading, setLoading] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["useState"])(true);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["useEffect"])(()=>{
        refreshUser();
    }, []);
    const refreshUser = async ()=>{
        try {
            const data = await __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$lib$2f$api$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["authAPI"].me();
            setUser(data);
        } catch (error) {
            setUser(null);
        } finally{
            setLoading(false);
        }
    };
    const login = async (email, password)=>{
        const data = await __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$lib$2f$api$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["authAPI"].login({
            email,
            password
        });
        if (data.success) {
            await refreshUser();
        }
    };
    const register = async (fullname, email, password, college)=>{
        const data = await __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$lib$2f$api$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["authAPI"].register({
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
        await __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$lib$2f$api$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["authAPI"].logout().catch(()=>undefined);
        clearClientAuthState();
        setUser(null);
    };
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])(AuthContext.Provider, {
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
function useAuth() {
    const context = (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["useContext"])(AuthContext);
    if (context === undefined) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
}
function clearClientAuthState() {
    if ("TURBOPACK compile-time truthy", 1) return;
    //TURBOPACK unreachable
    ;
    const clearStore = undefined;
}
}),
"[externals]/next/dist/server/app-render/work-unit-async-storage.external.js [external] (next/dist/server/app-render/work-unit-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/app-render/work-unit-async-storage.external.js", () => require("next/dist/server/app-render/work-unit-async-storage.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/app-render/work-async-storage.external.js [external] (next/dist/server/app-render/work-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/app-render/work-async-storage.external.js", () => require("next/dist/server/app-render/work-async-storage.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/app-render/action-async-storage.external.js [external] (next/dist/server/app-render/action-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/app-render/action-async-storage.external.js", () => require("next/dist/server/app-render/action-async-storage.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/app-render/after-task-async-storage.external.js [external] (next/dist/server/app-render/after-task-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/app-render/after-task-async-storage.external.js", () => require("next/dist/server/app-render/after-task-async-storage.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/app-render/dynamic-access-async-storage.external.js [external] (next/dist/server/app-render/dynamic-access-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/app-render/dynamic-access-async-storage.external.js", () => require("next/dist/server/app-render/dynamic-access-async-storage.external.js"));

module.exports = mod;
}),
];

//# sourceMappingURL=%5Broot-of-the-server%5D__03jth4p._.js.map