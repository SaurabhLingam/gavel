document.addEventListener("DOMContentLoaded", async () => {
    const listContainer = document.getElementById("my-products-list");
    if (!listContainer) return;

    // Auth check
    let currentUser = null;
    try {
        const meRes  = await fetch('/api/me');
        const meData = await meRes.json();
        if (!meData.loggedIn) {
            listContainer.innerHTML = `
                <div style="grid-column:1/-1; text-align:center; padding:80px 20px;">
                    <p style="color:#8b6f5b; font-size:1.1rem;">You must be logged in to view your listings.</p>
                    <a href="/login.html" class="btn-primary" style="display:inline-block; margin-top:20px;">Sign In</a>
                </div>`;
            return;
        }
        currentUser = meData.user;
    } catch(e) {
        listContainer.innerHTML = "<p>Error connecting to server.</p>";
        return;
    }

    let activeTab = 'active';

    // Build tab bar
    const tabBar = document.createElement('div');
    tabBar.style.cssText = 'display:flex; gap:10px; margin-bottom:30px;';
    tabBar.innerHTML = `
        <button id="tab-active" onclick="switchTab('active')"
            style="padding:10px 25px; border:2px solid var(--brass-gold); background:var(--brass-gold);
                   color:var(--polished-walnut); font-weight:bold; cursor:pointer; border-radius:4px;
                   font-size:0.85rem; text-transform:uppercase;">
            Active Lots
        </button>
        <button id="tab-closed" onclick="switchTab('closed')"
            style="padding:10px 25px; border:2px solid var(--brass-gold); background:transparent;
                   color:var(--deep-oak); font-weight:bold; cursor:pointer; border-radius:4px;
                   font-size:0.85rem; text-transform:uppercase;">
            Closed Lots
        </button>`;
    listContainer.before(tabBar);

    window.switchTab = (tab) => {
        activeTab = tab;
        const btnActive = document.getElementById('tab-active');
        const btnClosed = document.getElementById('tab-closed');
        if (tab === 'active') {
            btnActive.style.background = 'var(--brass-gold)';
            btnActive.style.color      = 'var(--polished-walnut)';
            btnClosed.style.background = 'transparent';
            btnClosed.style.color      = 'var(--deep-oak)';
        } else {
            btnClosed.style.background = 'var(--brass-gold)';
            btnClosed.style.color      = 'var(--polished-walnut)';
            btnActive.style.background = 'transparent';
            btnActive.style.color      = 'var(--deep-oak)';
        }
        loadMyProducts();
    };

    async function loadMyProducts() {
        listContainer.innerHTML = '<p style="color:#8b6f5b; text-align:center; padding:30px;">Loading...</p>';
        try {
            const [activeRes, closedRes] = await Promise.all([
                fetch('/api/auctions'),
                fetch('/api/auctions/closed')
            ]);
            const activeAuctions = await activeRes.json();
            const closedAuctions = await closedRes.json();
            const allAuctions    = activeTab === 'active' ? activeAuctions : closedAuctions;
            const myItems        = allAuctions.filter(item => item.sellerEmail === currentUser.email);

            if (myItems.length === 0) {
                listContainer.innerHTML = activeTab === 'active' ? `
                    <div style="grid-column:1/-1; text-align:center; padding:50px; color:#8b6f5b;">
                        <p>No active lots on the floor.</p>
                        <a href="sell-product.html" class="btn-primary" style="display:inline-block; margin-top:15px;">List an Item</a>
                    </div>` : `
                    <div style="grid-column:1/-1; text-align:center; padding:50px; color:#8b6f5b;">
                        <p style="font-style:italic;">No closed auctions yet.</p>
                    </div>`;
                return;
            }

            listContainer.innerHTML = "";
            myItems.forEach(item => renderCard(item));

        } catch (error) {
            listContainer.innerHTML = "<p>Error loading your collection.</p>";
        }
    }

    function renderCard(item) {
        const div      = document.createElement("div");
        div.classList.add("auction-item");
        div.id = `card-${item.id}`;

        const isClosed = item.status === 'closed';

        const statusBadge = isClosed
            ? `<span style="position:absolute; top:10px; right:10px; background:#2d1e16; color:#d4af37; padding:4px 8px; font-size:0.7rem; font-weight:bold; border-radius:3px;">CLOSED</span>`
            : item.verified
                ? `<span style="position:absolute; top:10px; right:10px; background:#27ae60; color:white; padding:4px 8px; font-size:0.7rem; font-weight:bold; border-radius:3px;">VERIFIED</span>`
                : `<span style="position:absolute; top:10px; right:10px; background:#f39c12; color:white; padding:4px 8px; font-size:0.7rem; font-weight:bold; border-radius:3px;">PENDING</span>`;

        let endTimeHtml = '';
        if (!isClosed && item.endTime) {
            const end = new Date(item.endTime);
            endTimeHtml = `<p style="font-size:0.8rem; color:#8b6f5b; margin-bottom:10px;">
                Ends: ${end.toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' })}
                at ${end.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' })}
            </p>`;
        }

        // Winner block for closed items
        let winnerHtml = '';
        if (isClosed) {
            if (item.winnerName) {
                winnerHtml = `
                    <div style="background:#f0fff4; border:1px solid #27ae60; border-radius:4px; padding:12px; margin-bottom:10px;">
                        <p style="margin:0; font-size:0.8rem; color:#27ae60; font-weight:bold; text-transform:uppercase;">Winner</p>
                        <p style="margin:4px 0 0; font-weight:bold; color:#2d4a3e;">${item.winnerName}</p>
                        <p style="margin:2px 0 0; font-size:0.9rem; color:var(--polished-walnut);">
                            ₹${Number(item.winningBid).toLocaleString('en-IN')}
                        </p>
                        <button onclick="showWinnerContact(${item.id})"
                            style="margin-top:8px; width:100%; padding:7px; background:var(--brass-gold); color:var(--polished-walnut);
                                   border:none; border-radius:3px; font-weight:bold; font-size:0.75rem; cursor:pointer; text-transform:uppercase;">
                            View Contact Details
                        </button>
                        <div id="winner-contact-${item.id}" style="display:none; margin-top:8px; font-size:0.85rem; color:#5c4033;"></div>
                    </div>`;
            } else {
                winnerHtml = `<p style="color:#8b6f5b; font-style:italic; font-size:0.85rem; margin-bottom:10px;">No bids were placed.</p>`;
            }
        }

        // Action buttons
        let actionsHtml = '';
        if (!isClosed) {
            actionsHtml = `
                <a href="/item-detail.html?id=${item.id}" class="btn-primary"
                   style="display:block; text-align:center; font-size:0.85rem; margin-bottom:8px;">
                    VIEW LIVE BID
                </a>
                <button onclick="endAuction(${item.id})"
                    style="width:100%; padding:10px; border:2px solid #c0392b; background:transparent;
                           color:#c0392b; font-weight:bold; cursor:pointer; border-radius:4px;
                           font-size:0.8rem; text-transform:uppercase;"
                    onmouseover="this.style.background='#c0392b'; this.style.color='white';"
                    onmouseout="this.style.background='transparent'; this.style.color='#c0392b';">
                    🔨 END AUCTION EARLY
                </button>
                ${item.bidCount === 0 ? `
                <button onclick="withdrawItem(${item.id})"
                    style="width:100%; margin-top:8px; padding:10px; border:none; background:#888;
                           color:white; font-weight:bold; cursor:pointer; border-radius:4px;
                           font-size:0.8rem; text-transform:uppercase;">
                    WITHDRAW (NO BIDS)
                </button>` : ''}`;
        } else {
            // Closed lot — show view + chat button (only if there's a winner)
            actionsHtml = `
                <a href="/item-detail.html?id=${item.id}" class="btn-primary"
                   style="display:block; text-align:center; font-size:0.85rem; margin-bottom:8px;">
                    VIEW AUCTION
                </a>
                ${item.winnerName ? `
                <a href="/chat.html?auction=${item.id}"
                   style="display:block; text-align:center; padding:12px; border-radius:4px;
                          background: linear-gradient(135deg, var(--deep-oak), var(--polished-walnut));
                          color: var(--brass-gold); font-weight:bold; font-size:0.85rem;
                          text-decoration:none; text-transform:uppercase; letter-spacing:1px;
                          border: 1px solid var(--brass-gold);">
                    💬 Chat with Winner
                </a>` : ''}`;
        }

        div.innerHTML = `
            <div style="position:relative; overflow:hidden; border-radius:4px;">
                ${statusBadge}
                <img src="${item.image}" alt="${item.title}" style="width:100%; height:200px; object-fit:cover;">
            </div>
            <div style="padding:15px;">
                <h3 style="margin-bottom:5px;">${item.title}</h3>
                <p style="margin-bottom:5px; color:#8b6f5b; font-size:0.85rem;">
                    ${item.bidCount || 0} bid${item.bidCount !== 1 ? 's' : ''}
                </p>
                <p style="margin-bottom:10px; font-weight:bold; color:var(--polished-walnut);">
                    ${isClosed ? 'Final Bid' : 'Current Bid'}: ₹${item.currentBid.toLocaleString('en-IN')}
                </p>
                ${endTimeHtml}
                ${winnerHtml}
                <div style="display:flex; flex-direction:column; gap:8px;">
                    ${actionsHtml}
                </div>
            </div>`;
        listContainer.appendChild(div);
    }

    window.endAuction = async (id) => {
        if (!confirm("End this auction now? The current highest bidder will win.")) return;
        try {
            const res  = await fetch('/api/end-auction', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id })
            });
            const data = await res.json();
            if (res.ok) loadMyProducts();
            else alert(data.message || "Failed to end auction.");
        } catch(e) { alert("Server error."); }
    };

    window.withdrawItem = async (id) => {
        if (!confirm("Withdraw this lot? It will be permanently removed.")) return;
        try {
            const res  = await fetch('/api/remove-item', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id })
            });
            const data = await res.json();
            if (res.ok) loadMyProducts();
            else alert(data.message || "Failed to withdraw.");
        } catch(e) {}
    };

    window.showWinnerContact = async (auctionId) => {
        const el = document.getElementById(`winner-contact-${auctionId}`);
        if (el.style.display === 'block') { el.style.display = 'none'; return; }
        try {
            const res  = await fetch(`/api/auction/${auctionId}/winner`);
            const data = await res.json();
            if (data.noBids) {
                el.textContent = 'No bids were placed.';
            } else {
                el.innerHTML = `<strong>Email:</strong> <a href="mailto:${data.email}" style="color:var(--brass-gold);">${data.email}</a>`;
            }
            el.style.display = 'block';
        } catch(e) {
            el.textContent     = 'Error loading contact.';
            el.style.display   = 'block';
        }
    };

    loadMyProducts();
});