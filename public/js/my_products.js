document.addEventListener("DOMContentLoaded", async () => {
    const listContainer = document.getElementById("my-products-list");
    // Simulated logged-in user to match the sellerEmail set in server.js
    const currentUserEmail = "saurabh@gavel.com"; 

    if (!listContainer) return;

    /**
     * Fetches and renders only the products belonging to the current user
     */
    async function loadMyProducts() {
        try {
            const response = await fetch('/api/auctions');
            if (!response.ok) throw new Error("Could not fetch auctions");
            
            const allAuctions = await response.json();
            
            // Filter: Identify products where the current user is the seller
            const myItems = allAuctions.filter(item => item.sellerEmail === currentUserEmail);

            // Handle the state where no items have been listed yet
            if (myItems.length === 0) {
                listContainer.innerHTML = `
                    <div style="grid-column: 1/-1; text-align: center; padding: 50px; color: #8b6f5b;">
                        <p>You haven't authorized any listings yet.</p>
                        <a href="sell-product.html" class="btn-primary" style="display: inline-block; margin-top: 15px;">List an Item</a>
                    </div>`;
                return;
            }

            listContainer.innerHTML = ""; // Clear existing cards

            myItems.forEach(item => {
                const div = document.createElement("div");
                div.classList.add("auction-item");
                
                // Show a verification status badge for the seller
                const statusBadge = item.verified 
                    ? `<span style="position:absolute; top:10px; right:10px; background:#27ae60; color:white; padding:4px 8px; font-size:0.7rem; font-weight:bold; border-radius:3px;">VERIFIED</span>`
                    : `<span style="position:absolute; top:10px; right:10px; background:#f39c12; color:white; padding:4px 8px; font-size:0.7rem; font-weight:bold; border-radius:3px;">PENDING REVIEW</span>`;

                div.innerHTML = `
                    <div style="position: relative; overflow: hidden; border-radius: 4px;">
                        ${statusBadge}
                        <img src="${item.image}" alt="${item.title}" style="width:100%; height:200px; object-fit:cover;">
                    </div>
                    <div style="padding: 15px;">
                        <h3 style="margin-bottom: 5px;">${item.title}</h3>
                        <p style="margin-bottom: 15px; font-weight: bold; color: var(--polished-walnut);">
                            Current Bid: ₹${item.currentBid.toLocaleString('en-IN')}
                        </p>
                        
                        <div style="display: flex; flex-direction: column; gap: 10px;">
                            <button onclick="editItem(${item.id})" class="btn-primary" style="background: var(--brass-gold); color: var(--polished-walnut); border: none;">
                                EDIT DETAILS
                            </button>
                            <button onclick="withdrawItem(${item.id})" style="background: #c0392b; color: white; border: none; padding: 12px; border-radius: 4px; cursor: pointer; font-weight: bold; text-transform: uppercase; font-size: 0.8rem;">
                                WITHDRAW LOT
                            </button>
                        </div>
                    </div>
                `;
                listContainer.appendChild(div);
            });
        } catch (error) {
            console.error("Dashboard Error:", error);
            listContainer.innerHTML = "<p>Error loading your collection.</p>";
        }
    }

    /**
     * Sends a request to the server to remove a specific lot by ID
     */
    window.withdrawItem = async (id) => {
        if (!confirm("Are you sure you want to withdraw this specific lot? This action cannot be undone.")) return;

        try {
            const res = await fetch('/api/remove-item', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id }) // Uses the unique ID to prevent deleting duplicates
            });

            if (res.ok) {
                loadMyProducts(); // Refresh the list without reloading the whole page
            } else {
                alert("Failed to withdraw the item.");
            }
        } catch (err) {
            console.error("Withdraw Error:", err);
        }
    };

    /**
     * Placeholder for the Edit Detail feature
     */
    window.editItem = (id) => {
        alert("The Edit feature is being integrated into the Gavel backend. (Item ID: " + id + ")");
    };

    // Initial load
    loadMyProducts();
});