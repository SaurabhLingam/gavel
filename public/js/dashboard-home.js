let user = null;
let profileState = null;
let walletRefreshIntervalId = null;
let activeWalletPollOrderId = '';

function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function refreshDashboardHomeSummary(options = {}) {
    const profile = await api.get(`/dashboard/summary?ts=${Date.now()}`);
    if (!profile || profile.error) {
        if (!options.silent) UI.toast(profile?.error || 'Failed to refresh wallet state.', 'error');
        return null;
    }
    profileState = profile || {};
    updateStats(profileState?.me || profileState?.user || {});
    updateCampusBadge(profileState?.me || profileState?.user || {});
    updateWatchlistSubline(profileState?.watchlist || []);
    return profileState;
}

function startWalletRefreshLoop() {
    if (walletRefreshIntervalId) window.clearInterval(walletRefreshIntervalId);
    walletRefreshIntervalId = window.setInterval(() => {
        if (document.visibilityState === 'visible') {
            refreshDashboardHomeSummary({ silent: true });
        }
    }, 20000);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            refreshDashboardHomeSummary({ silent: true });
        }
    });
}

async function pollWalletOrderStatus(orderId, amount) {
    if (!orderId) return false;
    activeWalletPollOrderId = orderId;
    for (let attempt = 0; attempt < 24; attempt += 1) {
        if (activeWalletPollOrderId !== orderId) return false;
        const status = await api.get(`/payments/razorpay/status/${encodeURIComponent(orderId)}?ts=${Date.now()}`);
        if (activeWalletPollOrderId !== orderId) return false;
        if (status?.status === 'paid' || status?.success) {
            activeWalletPollOrderId = '';
            UI.closeModal();
            await refreshDashboardHomeSummary({ silent: true });
            UI.toast(`Wallet credited with ${UI.formatPrice(amount)}.`, 'success');
            return true;
        }
        if (status?.status === 'failed') {
            activeWalletPollOrderId = '';
            UI.toast(status?.error || 'Razorpay payment did not complete.', 'error');
            return false;
        }
        await delay(3500);
    }
    if (activeWalletPollOrderId === orderId) {
        activeWalletPollOrderId = '';
        UI.toast('Payment is still pending. The wallet amount will refresh after Razorpay confirms it.', 'info');
    }
    return false;
}

(async function initDashboardHome() {
    await Auth.init();
    if (!Auth.isLoggedIn()) {
        window.location.href = '/login.html';
        return;
    }

    user = Auth.getUser();
    if (!user) return;

    const logoLink = document.getElementById('logoLink');
    if (logoLink) logoLink.href = '/dashboard-home.html';

    updateGreeting(user);
    document.getElementById('loginBtn')?.classList.add('hide');
    document.getElementById('signupBtn')?.classList.add('hide');
    document.getElementById('messagesBtn')?.classList.remove('hide');
    document.getElementById('myListingsBtn')?.classList.remove('hide');
    document.getElementById('dashboardBtn')?.classList.remove('hide');
    if (user.isAdmin || user.isSuperAdmin) {
        document.getElementById('adminBanner')?.classList.remove('hide');
    }

    const [profile, bids, endingSoon, recommended] = await Promise.all([
        api.get(`/dashboard/summary?ts=${Date.now()}`),
        api.get('/my-bids'),
        api.get('/auctions?sort=endingSoon&limit=6&lightweight=1'),
        api.get('/recommendations/for-you')
    ]);

    profileState = profile || {};
    updateStats(profileState?.me || profileState?.user || {});
    updateCampusBadge(profileState?.me || profileState?.user || {});
    updateWatchlistSubline(profileState?.watchlist || []);
    renderActivityStrip(bids || []);
    renderEndingSoon((endingSoon || []).slice(0, 4));
    renderRecommended(recommended || []);
    loadRecentlyViewed();
    startWalletRefreshLoop();
    UI.startCountdowns();
})();

function updateGreeting(currentUser) {
    const hour = new Date().getHours();
    let greeting = 'Good evening';
    if (hour < 12) greeting = 'Good morning';
    else if (hour < 17) greeting = 'Good afternoon';
    const name = currentUser.name ? currentUser.name.split(' ')[0] : currentUser.email.split('@')[0];
    const el = document.getElementById('greetingText');
    if (el) el.textContent = `${greeting}, ${name}`;
}

function updateStats(summaryUser) {
    const stats = profileState?.stats || {};
    const walletEl = document.getElementById('walletPill');
    const activeBidsEl = document.getElementById('activeBidsPill');
    const itemsSoldEl = document.getElementById('itemsSoldPill');
    if (walletEl) {
        walletEl.querySelector('.stat-pill-value').textContent = UI.formatPrice(summaryUser.walletBalance || 0);
        walletEl.title = `Available to withdraw: ${UI.formatPrice(summaryUser.availableToWithdraw || 0)} · Active commitments: ${UI.formatPrice(summaryUser.committedBidBalance || 0)}`;
    }
    if (activeBidsEl) activeBidsEl.querySelector('.stat-pill-value').textContent = stats.activeBids || 0;
    if (itemsSoldEl) itemsSoldEl.querySelector('.stat-pill-value').textContent = stats.soldListings || stats.closedListings || 0;
}

function updateCampusBadge(summaryUser) {
    const badge = document.getElementById('campusBadge');
    if (!badge) return;
    const college = String(summaryUser.college || '').trim();
    if (!college) {
        badge.classList.add('hide');
        badge.textContent = '';
        return;
    }
    badge.textContent = college;
    badge.classList.remove('hide');
}

function updateWatchlistSubline(watchlist) {
    const subline = document.getElementById('watchlistSubline');
    if (!subline) return;
    const count = Array.isArray(watchlist) ? watchlist.length : 0;
    if (!count) {
        subline.textContent = 'No watched auctions yet. Explore listings and save the ones you want to track.';
        return;
    }
    subline.textContent = `${count} watched auction${count !== 1 ? 's' : ''} ready for quick follow-up.`;
}

function renderActivityStrip(bids) {
    const container = document.getElementById('activityStrip');
    const empty = document.getElementById('activityEmpty');
    if (!container || !empty) return;

    container.innerHTML = '';
    const items = (Array.isArray(bids) ? bids : [])
        .filter((bid) => bid.auctionStatus === 'active' || bid.auctionStatus === 'closed')
        .slice(0, 4);

    if (!items.length) {
        empty.classList.remove('hide');
        return;
    }

    empty.classList.add('hide');
    items.forEach((item) => {
        const isClosed = item.auctionStatus === 'closed';
        const isWinningClosed = isClosed && item.winnerEmail === user.email;
        const statusClass = isWinningClosed || !isClosed ? 'winning' : 'outbid';
        const label = isWinningClosed ? 'Won' : isClosed ? 'Closed' : 'Live';
        const meta = isWinningClosed
            ? 'You won this auction. Open the receipt or continue the handoff.'
            : isClosed
                ? 'This auction closed. Open the item to review the result.'
                : `Last bid: ${new Date(item.placedAt).toLocaleString('en-IN')}`;
        const actionText = isWinningClosed ? 'Continue handoff' : 'Open item';
        const href = isWinningClosed ? `/winner-confirmation.html?id=${item.auctionId}` : `/item-detail.html?id=${item.auctionId}`;

        const card = document.createElement('div');
        card.className = `activity-card ${statusClass}`;
        card.innerHTML = `
            <span class="activity-label">${label}</span>
            <div class="activity-card-title">${escapeHtml(item.auctionTitle || 'Auction')}</div>
            <div class="activity-card-price">${UI.formatPrice(item.amount || item.currentBid || 0)}</div>
            <div class="activity-meta">${meta}</div>
            <a class="btn btn-sm ${statusClass === 'outbid' ? 'btn-secondary' : 'btn-primary'}" href="${href}" style="width:fit-content;">${actionText}</a>
        `;
        container.appendChild(card);
    });
}

function renderEndingSoon(auctions) {
    const container = document.getElementById('endingSoonStrip');
    if (!container) return;
    if (!Array.isArray(auctions) || !auctions.length) {
        container.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><h3>No live auctions yet</h3><p>Ending-soon items will appear here automatically.</p></div>';
        return;
    }
    container.innerHTML = '';
    auctions.forEach((auction) => {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = UI.renderAuctionCard(auction);
        const card = wrapper.firstElementChild;
        if (card) container.appendChild(card);
    });
}

function renderRecommended(auctions) {
    const container = document.getElementById('recommendedGrid');
    if (!container) return;
    if (!Array.isArray(auctions) || !auctions.length) {
        container.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><h3>No recommendations yet</h3><p>Browse explore to build your feed.</p></div>';
        return;
    }
    container.innerHTML = '';
    auctions.slice(0, 8).forEach((auction) => {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = UI.renderAuctionCard(auction);
        const card = wrapper.firstElementChild;
        if (card) container.appendChild(card);
    });
}

function loadRecentlyViewed() {
    const container = document.getElementById('recentlyViewedStrip');
    const section = document.getElementById('recentlyViewedSection');
    if (!container || !section) return;
    const recent = JSON.parse(localStorage.getItem('gavel_recently_viewed') || '[]').slice(0, 4);
    if (!recent.length) {
        section.classList.add('hide');
        return;
    }
    section.classList.remove('hide');
    container.innerHTML = recent.map((item) => `
        <a href="/item-detail.html?id=${item.id}" class="recently-viewed-card" style="text-decoration:none;">
            <div class="recently-viewed-media" style="${item.image ? `background-image:url('${item.image}')` : ''}"></div>
            <div class="activity-card-title">${escapeHtml(item.name || 'Listing')}</div>
            <div class="activity-meta">Last seen bid ${UI.formatPrice(item.bid || 0)}</div>
            <span class="btn btn-ghost btn-sm" style="width:fit-content;">Open again</span>
        </a>
    `).join('');
}

async function addWalletFunds() {
    UI.showModal(`
        <h3>Top up your wallet</h3>
        <p style="margin-top:var(--space-3);color:var(--text-secondary);">You will be redirected through Razorpay checkout. Once Razorpay confirms the payment, the same amount is credited to your wallet.</p>
        <div class="form-group" style="margin-top:var(--space-4);">
            <label class="form-label">Amount</label>
            <input id="dashboardHomeTopupAmount" class="form-input" type="number" min="100" step="100" value="1000">
            <p class="text-muted text-sm" style="margin-top:var(--space-2);">Minimum top-up is ₹100. The wallet amount refreshes automatically after confirmation.</p>
        </div>
        <div style="display:flex;gap:var(--space-3);margin-top:var(--space-5);">
            <button class="btn btn-ghost" onclick="UI.closeModal()" style="flex:1;">Cancel</button>
            <button class="btn btn-primary" onclick="startDashboardTopup()" style="flex:1;">Continue</button>
        </div>
    `);
}

async function startDashboardTopup() {
    const amount = Number(document.getElementById('dashboardHomeTopupAmount')?.value || 0);
    if (!Number.isFinite(amount) || amount < 100) {
        UI.toast('Enter a valid amount of at least ₹100.', 'error');
        return;
    }
    const orderResponse = await api.post('/payments/razorpay/order', { amount });
    if (!orderResponse?.order?.id) {
        if (orderResponse?.paymentLink) {
            window.location.href = orderResponse.paymentLink;
            return;
        }
        UI.toast(orderResponse?.error || 'Wallet top-up failed.', 'error');
        return;
    }
    if (typeof window.Razorpay !== 'function') {
        UI.toast('Razorpay checkout is not available right now.', 'error');
        return;
    }

    const orderId = orderResponse.order.id;
    void pollWalletOrderStatus(orderId, amount);

    const checkout = new window.Razorpay({
        key: orderResponse.keyId,
        order_id: orderId,
        amount: orderResponse.order.amount,
        currency: orderResponse.order.currency || 'INR',
        name: 'Gavel',
        description: `Wallet top-up of ${UI.formatPrice(amount)}`,
        notes: orderResponse.order.notes || {},
        handler: async (response) => {
            const verified = await api.post('/payments/razorpay/verify', response);
            if (verified?.success) {
                activeWalletPollOrderId = '';
                UI.closeModal();
                await refreshDashboardHomeSummary({ silent: true });
                UI.toast(`Wallet credited with ${UI.formatPrice(amount)}.`, 'success');
                return;
            }
            UI.toast(verified?.error || 'Payment received. Waiting for Razorpay confirmation.', 'info');
        },
        modal: {
            ondismiss: () => {
                UI.toast('Checking payment status for the latest wallet top-up.', 'info');
            }
        },
        theme: { color: '#365314' }
    });

    checkout.open();
}

async function withdrawWalletFunds() {
    const availableAmount = Number(profileState?.me?.availableToWithdraw ?? profileState?.user?.availableToWithdraw ?? 0);
    UI.showModal(`
        <h3>Withdraw from wallet</h3>
        <p style="margin-top:var(--space-3);color:var(--text-secondary);">Withdrawals are blocked if the amount would reduce your balance below the reserve commitments for active auctions you are participating in.</p>
        <div class="form-group" style="margin-top:var(--space-4);">
            <label class="form-label">Amount</label>
            <input id="dashboardHomeWithdrawAmount" class="form-input" type="number" min="1" step="1" value="${Math.max(0, Math.min(availableAmount || 1000, 1000))}">
            <p class="text-muted text-sm" style="margin-top:var(--space-2);">Available to withdraw right now: ${UI.formatPrice(availableAmount)}.</p>
        </div>
        <div style="display:flex;gap:var(--space-3);margin-top:var(--space-5);">
            <button class="btn btn-ghost" onclick="UI.closeModal()" style="flex:1;">Cancel</button>
            <button class="btn btn-primary" onclick="startDashboardWithdraw()" style="flex:1;">Withdraw</button>
        </div>
    `);
}

async function startDashboardWithdraw() {
    const amount = Number(document.getElementById('dashboardHomeWithdrawAmount')?.value || 0);
    if (!Number.isFinite(amount) || amount < 1) {
        UI.toast('Enter a valid amount.', 'error');
        return;
    }
    const withdraw = await api.post('/wallet/withdraw', { amount });
    if (!withdraw?.success) {
        UI.toast(withdraw?.error || 'Withdrawal failed.', 'error');
        return;
    }
    UI.closeModal();
    await refreshDashboardHomeSummary({ silent: true });
    UI.toast(`Withdrawal completed for ${UI.formatPrice(amount)}.`, 'success');
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
