require("dotenv").config();
const express = require("express");
const app = express();
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const axios = require("axios");

app.use(cors());
app.use(express.json());

app.post("/create-checkout-session", async (req, res) => {
  const { items, customer_email } = req.body;

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['p24'],
    mode: 'payment',
    line_items: items,
    customer_email,
    success_url: 'https://luxenordique.com/success',
    cancel_url: 'https://luxenordique.com/cart',
  });

  res.json({ url: session.url });
});


//session route
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Handle webhook before express.json()
app.post("/webhook", express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error("❌ Webhook Error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    createShopifyOrder(session);
  }

  res.status(200).send('Webhook received');
});

// After webhook, now apply json parser
app.use(express.json());

async function createShopifyOrder(session) {
  const shopifyToken = process.env.SHOPIFY_ADMIN_TOKEN;

  const orderData = {
    order: {
      email: session.customer_details.email,
      financial_status: "paid",
      line_items: [
        {
          title: "Stripe P24 Order",
          price: session.amount_total / 100,
          quantity: 1
        }
      ],
      note: "Paid via Przelewy24 using Stripe Checkout"
    }
  };

  try {
    await axios.post(
      `https://luxenordique.com/admin/api/2023-01/orders.json`,
      orderData,
      {
        headers: {
          'X-Shopify-Access-Token': shopifyToken,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log("✅ Shopify Order Created");
  } catch (error) {
    console.error("❌ Shopify Order Creation Failed", error.response.data);
  }
}
app.get("/", (req, res) => {
  res.send("✅ Shopify Stripe backend is working!");
});

app.listen(3000, () => {
  console.log("Server is running on port 3000");
});