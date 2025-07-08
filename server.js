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

app.post("/webhook", express.raw({ type: 'application/json' }), (request, response) => {
  const sig = request.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(request.body, sig, endpointSecret);
  } catch (err) {
    console.log(err.message);
    return response.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle successful payment
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // ✅ Call Shopify Admin API here to create the order
    createShopifyOrder(session);
  }

  response.status(200).send('Received');
});

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
app.listen(3000, () => {
  console.log("Server is running on port 3000");
});