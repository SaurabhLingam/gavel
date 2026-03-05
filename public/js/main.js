document.addEventListener("DOMContentLoaded", async () => {
    const auctionList = document.getElementById("auction-list");
    if (!auctionList) return;

    try {
        const response = await fetch('/api/auctions');
        if (!response.ok) throw new Error('Network response was not ok');
        const auctions = await response.json();

        auctionList.innerHTML = "";

        if (auctions.length === 0) {
            auctionList.innerHTML = `
                <div style="grid-column: 1 / -1; padding: 50px; color: #8b6f5b; font-style: italic;">
                    <p>The auction floor is currently quiet. No items have been consigned yet.</p>
                </div>`;
            return;
        }

        const isHomepage = window.location.pathname.endsWith("index.html") ||
                           window.location.pathname === "/" ||
                           window.location.pathname.endsWith("/");

        const displayList = isHomepage ? auctions.slice(0, 3) : auctions;

        displayList.forEach(item => {
            const div = document.createElement("div");
            div.classList.add("auction-item");

            const verificationBadge = !item.verified
                ? `<span style="position:absolute; top:10px; right:10px; background:var(--brass-gold); color:var(--polished-walnut); padding:4px 10px; font-size:0.7rem; font-weight:bold; border-radius:3px; z-index:5; box-shadow: 0 2px 8px rgba(0,0,0,0.3);">UNVERIFIED</span>`
                : '';

            div.innerHTML = `
                <div style="position: relative; overflow: hidden; border-radius: 4px;">
                    ${verificationBadge}
                    <img src="${item.image}" alt="${item.title}" style="width:100%; height:200px; object-fit:cover; transition: transform 0.5s ease;">
                </div>
                <div style="padding-top: 15px;">
                    <h3 style="margin-bottom: 10px;">${item.title}</h3>
                    <p style="height: 45px; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;">
                        ${item.description}
                    </p>
                    <p style="margin: 15px 0;"><strong>Current Bid: ₹${item.currentBid.toLocaleString('en-IN')}</strong></p>
                    <a href="item-detail.html?item=${encodeURIComponent(item.title)}" class="btn-primary" style="display: block; text-align: center;">VIEW BID</a>
                </div>
            `;
            auctionList.appendChild(div);
        });

    } catch (error) {
        console.error("Gavel Client Error:", error);
        auctionList.innerHTML = `
            <div style="grid-column: 1 / -1; padding: 40px; text-align: center;">
                <p style="color: #e74c3c; font-weight: bold;">Unable to connect to the auction house floor.</p>
                <button onclick="location.reload()" class="btn-primary" style="margin-top: 15px; padding: 10px 20px; font-size: 0.8rem;">Retry Connection</button>
            </div>`;
    }
});
