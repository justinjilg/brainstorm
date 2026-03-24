// script.js - Brainstorm AI Application
// Initialize on DOMContentLoaded
document.addEventListener('DOMContentLoaded', function() {
    // Initialize all features
    initThemeToggle();
    initMobileMenu();
    initScrollReveal();
    initSmoothScrolling();
    initPricingCalculator();
});

// 1. PRICING CALCULATOR
class PricingCalculator {
    constructor() {
        this.tiers = {
            starter: { name: 'Starter', price: 9 },
            pro: { name: 'Pro', price: 29 },
            enterprise: { name: 'Enterprise', price: 79 }
        };
        
        this.discounts = [
            { minUsers: 100, discount: 0.30 },
            { minUsers: 50, discount: 0.20 },
            { minUsers: 10, discount: 0.10 }
        ];
        
        this.taxRates = {
            'US': 0.085,
            'EU': 0.20,
            'UK': 0.20,
            'CA': 0.13,
            'AU': 0.10,
            'other': 0.00
        };
        
        this.regions = [
            { code: 'US', name: 'United States' },
            { code: 'EU', name: 'European Union' },
            { code: 'UK', name: 'United Kingdom' },
            { code: 'CA', name: 'Canada' },
            { code: 'AU', name: 'Australia' },
            { code: 'other', name: 'Other (No Tax)' }
        ];
    }
    
    calculate(tier, users, region) {
        const tierData = this.tiers[tier];
        if (!tierData) {
            throw new Error(`Invalid tier: ${tier}`);
        }
        
        const subtotal = tierData.price * users;
        
        // Apply volume discount
        let discountRate = 0;
        for (const discount of this.discounts) {
            if (users >= discount.minUsers) {
                discountRate = discount.discount;
                break;
            }
        }
        
        const discountAmount = subtotal * discountRate;
        const discountedSubtotal = subtotal - discountAmount;
        
        // Apply tax
        const taxRate = this.taxRates[region] || this.taxRates['other'];
        const taxAmount = discountedSubtotal * taxRate;
        const total = discountedSubtotal + taxAmount;
        
        return {
            subtotal: Math.round(subtotal * 100) / 100,
            discount: Math.round(discountAmount * 100) / 100,
            discountRate: discountRate * 100,
            tax: Math.round(taxAmount * 100) / 100,
            taxRate: taxRate * 100,
            total: Math.round(total * 100) / 100,
            perUser: tierData.price,
            tierName: tierData.name
        };
    }
    
    renderUI(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;
        
        container.innerHTML = `
            <div class="pricing-container">
                <div class="pricing-header">
                    <h2>Choose Your Plan</h2>
                    <p>Select a tier, adjust users, and see real-time pricing</p>
                </div>
                
                <div class="pricing-controls">
                    <div class="tier-selector">
                        <h3>Select Tier</h3>
                        <div class="tier-cards">
                            ${Object.entries(this.tiers).map(([key, tier]) => `
                                <div class="tier-card" data-tier="${key}">
                                    <h4>${tier.name}</h4>
                                    <div class="tier-price">$${tier.price}<span>/user/month</span></div>
                                    <ul class="tier-features">
                                        ${this.getTierFeatures(key)}
                                    </ul>
                                    <button class="btn-select-tier" data-tier="${key}">Select Plan</button>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                    
                    <div class="calculator-controls">
                        <div class="control-group">
                            <label for="user-slider">Users: <span id="user-count">10</span></label>
                            <input type="range" id="user-slider" min="1" max="200" value="10" class="user-slider">
                            <div class="slider-labels">
                                <span>1</span>
                                <span>50</span>
                                <span>100</span>
                                <span>150</span>
                                <span>200</span>
                            </div>
                        </div>
                        
                        <div class="control-group">
                            <label for="region-select">Region:</label>
                            <select id="region-select" class="region-select">
                                ${this.regions.map(region => `
                                    <option value="${region.code}">${region.name}</option>
                                `).join('')}
                            </select>
                        </div>
                    </div>
                    
                    <div class="pricing-results">
                        <div class="results-header">
                            <h3>Cost Breakdown</h3>
                            <div class="selected-tier-display">
                                <span id="selected-tier-name">Pro</span> Plan
                            </div>
                        </div>
                        
                        <div class="results-details">
                            <div class="result-row">
                                <span>Subtotal</span>
                                <span id="subtotal">$290.00</span>
                            </div>
                            <div class="result-row discount">
                                <span>Volume Discount (<span id="discount-rate">0%</span>)</span>
                                <span id="discount">-$0.00</span>
                            </div>
                            <div class="result-row">
                                <span>Tax (<span id="tax-rate">8.5%</span>)</span>
                                <span id="tax">$24.65</span>
                            </div>
                            <div class="result-row total">
                                <span>Total (monthly)</span>
                                <span id="total">$314.65</span>
                            </div>
                            <div class="result-row annual">
                                <span>Annual Total (Save 10%)</span>
                                <span id="annual-total">$3,398.22</span>
                            </div>
                        </div>
                        
                        <button class="btn-get-started">Get Started</button>
                    </div>
                </div>
            </div>
        `;
        
        // Initialize with default values
        this.selectedTier = 'pro';
        this.updateSelectedTier();
        this.updateCalculation();
        
        // Add event listeners
        this.bindEvents();
    }
    
    getTierFeatures(tier) {
        const features = {
            starter: [
                'Up to 5 projects',
                'Basic code completion',
                'Community support',
                'Email support'
            ],
            pro: [
                'Unlimited projects',
                'Advanced code completion',
                'Priority support',
                'Team collaboration',
                'Custom integrations'
            ],
            enterprise: [
                'Everything in Pro',
                'Dedicated account manager',
                'Custom AI training',
                'SLA guarantee',
                'On-premise deployment',
                '24/7 phone support'
            ]
        };
        
        return features[tier].map(feature => `<li>${feature}</li>`).join('');
    }
    
    bindEvents() {
        // Tier selection
        document.querySelectorAll('.btn-select-tier').forEach(button => {
            button.addEventListener('click', (e) => {
                this.selectedTier = e.target.dataset.tier;
                this.updateSelectedTier();
                this.updateCalculation();
            });
        });
        
        // User slider
        const userSlider = document.getElementById('user-slider');
        const userCount = document.getElementById('user-count');
        
        userSlider.addEventListener('input', (e) => {
            userCount.textContent = e.target.value;
            this.updateCalculation();
        });
        
        // Region select
        document.getElementById('region-select').addEventListener('change', () => {
            this.updateCalculation();
        });
        
        // Get Started button
        document.querySelector('.btn-get-started').addEventListener('click', () => {
            this.handleGetStarted();
        });
    }
    
    updateSelectedTier() {
        // Update tier cards
        document.querySelectorAll('.tier-card').forEach(card => {
            card.classList.remove('selected');
            if (card.dataset.tier === this.selectedTier) {
                card.classList.add('selected');
            }
        });
        
        // Update selected tier display
        const tierName = this.tiers[this.selectedTier].name;
        document.getElementById('selected-tier-name').textContent = tierName;
    }
    
    updateCalculation() {
        const users = parseInt(document.getElementById('user-slider').value);
        const region = document.getElementById('region-select').value;
        
        const result = this.calculate(this.selectedTier, users, region);
        
        // Update UI with results
        document.getElementById('subtotal').textContent = `$${result.subtotal.toFixed(2)}`;
        document.getElementById('discount').textContent = `-$${result.discount.toFixed(2)}`;
        document.getElementById('discount-rate').textContent = `${result.discountRate}%`;
        document.getElementById('tax').textContent = `$${result.tax.toFixed(2)}`;
        document.getElementById('tax-rate').textContent = `${result.taxRate}%`;
        document.getElementById('total').textContent = `$${result.total.toFixed(2)}`;
        
        // Calculate annual total with 10% discount
        const annualTotal = result.total * 12 * 0.9;
        document.getElementById('annual-total').textContent = `$${annualTotal.toFixed(2)}`;
    }
    
    handleGetStarted() {
        const users = parseInt(document.getElementById('user-slider').value);
        const region = document.getElementById('region-select').value;
        const regionName = this.regions.find(r => r.code === region).name;
        
        alert(`Thank you for choosing ${this.tiers[this.selectedTier].name} Plan!\n\n` +
              `Users: ${users}\n` +
              `Region: ${regionName}\n` +
              `Monthly Total: $${this.calculate(this.selectedTier, users, region).total.toFixed(2)}\n\n` +
              `You will be redirected to the signup page.`);
    }
}

// 2. THEME TOGGLE
function initThemeToggle() {
    const themeToggle = document.querySelector('.theme-toggle');
    if (!themeToggle) return;
    
    const html = document.documentElement;
    
    // Check for saved theme preference or respect the default dark class
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme) {
        html.classList.remove('dark', 'light');
        html.classList.add(savedTheme);
    }
    
    // Update button icon based on current theme
    updateThemeIcons();
    
    themeToggle.addEventListener('click', () => {
        const isDark = html.classList.contains('dark');
        
        if (isDark) {
            html.classList.remove('dark');
            html.classList.add('light');
            localStorage.setItem('theme', 'light');
        } else {
            html.classList.remove('light');
            html.classList.add('dark');
            localStorage.setItem('theme', 'dark');
        }
        
        updateThemeIcons();
    });
    
    function updateThemeIcons() {
        const moonIcon = themeToggle.querySelector('.fa-moon');
        const sunIcon = themeToggle.querySelector('.fa-sun');
        
        if (!moonIcon || !sunIcon) return;
        
        const isDark = document.documentElement.classList.contains('dark');
        
        if (isDark) {
            moonIcon.style.display = 'block';
            sunIcon.style.display = 'none';
        } else {
            moonIcon.style.display = 'none';
            sunIcon.style.display = 'block';
        }
    }
}

// 3. SCROLL REVEAL with IntersectionObserver
function initScrollReveal() {
    const revealElements = document.querySelectorAll('.reveal');
    
    if (!revealElements.length) return;
    
    const observerOptions = {
        root: null,
        rootMargin: '0px',
        threshold: 0.1
    };
    
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
                // Optional: unobserve after revealing
                // observer.unobserve(entry.target);
            }
        });
    }, observerOptions);
    
    revealElements.forEach(element => {
        observer.observe(element);
    });
}

// Mobile menu toggle (existing functionality)
function initMobileMenu() {
    const mobileMenuBtn = document.querySelector('.mobile-menu-btn');
    const navLinks = document.querySelector('.nav-links');
    
    if (!mobileMenuBtn || !navLinks) return;
    
    mobileMenuBtn.addEventListener('click', () => {
        navLinks.classList.toggle('active');
        mobileMenuBtn.classList.toggle('active');
    });
}

// Smooth scrolling for anchor links (existing functionality)
function initSmoothScrolling() {
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function(e) {
            e.preventDefault();
            
            const targetId = this.getAttribute('href');
            if (targetId === '#') return;
            
            const targetElement = document.querySelector(targetId);
            if (targetElement) {
                window.scrollTo({
                    top: targetElement.offsetTop - 80,
                    behavior: 'smooth'
                });
                
                // Close mobile menu if open
                const navLinks = document.querySelector('.nav-links');
                const mobileMenuBtn = document.querySelector('.mobile-menu-btn');
                if (navLinks && mobileMenuBtn) {
                    navLinks.classList.remove('active');
                    mobileMenuBtn.classList.remove('active');
                }
            }
        });
    });
}

// Initialize pricing calculator
function initPricingCalculator() {
    const pricingApp = document.getElementById('pricing-app');
    if (!pricingApp) return;
    
    const calculator = new PricingCalculator();
    calculator.renderUI('pricing-app');
}