require("dotenv").config();
const express = require("express");
const app = express();
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const axios = require("axios");

app.use(cors());

// Handle webhook before express.json()
app.post("/webhook", express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("❌ Webhook Error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const rawSession = event.data.object;

    try {
      const session = await stripe.checkout.sessions.retrieve(rawSession.id, {
        expand: ['shipping', 'customer_details'],
      });

      console.log("✅ Payment successful. Session ID:", session.id);
      await createShopifyOrder(session);
    } catch (err) {
      console.error("❌ Failed to retrieve full session:", err.message);
    }
  }

  res.status(200).send('Webhook received');
});


// After webhook, now apply json parser
app.use(express.json());


async function createShopifyOrder(session) {
  console.log("Creating Shopify order for session:", session.id);

  const shipping = session.shipping || {};
  const shippingAddress = shipping.address || {};
  const customerDetails = session.customer_details || {};

  const orderData = {
    draft_order: {
      email: customerDetails.email,
      note: "Paid via Przelewy24 using Stripe Checkout",
      customer: {
        first_name: shipping.name?.split(' ')[0] || '',
        last_name: shipping.name?.split(' ')[1] || '',
        phone: customerDetails.phone || '',
      },
      shipping_address: {
        first_name: shipping.name?.split(' ')[0] || '',
        last_name: shipping.name?.split(' ')[1] || '',
        address1: shippingAddress.line1 || '',
        address2: shippingAddress.line2 || '',
        city: shippingAddress.city || '',
        zip: shippingAddress.postal_code || '',
        country: shippingAddress.country || '',
        province: shippingAddress.state || '',
        phone: customerDetails.phone || '',
      },
      billing_address: {
        first_name: shipping.name?.split(' ')[0] || '',
        last_name: shipping.name?.split(' ')[1] || '',
        address1: shippingAddress.line1 || '',
        address2: shippingAddress.line2 || '',
        city: shippingAddress.city || '',
        zip: shippingAddress.postal_code || '',
        country: shippingAddress.country || '',
        province: shippingAddress.state || '',
        phone: customerDetails.phone || '',
      },
      line_items: [
        {
          title: "Stripe P24 Order",
          price: session.amount_total / 100,
          quantity: 1,
        },
      ],
      use_customer_default_address: false,
    },
  };

  try {
    const response = await axios.post(
      `https://2495e7.myshopify.com/admin/api/2023-01/draft_orders.json`,
      orderData,
      {
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log("✅ Shopify draft order created:", response.data.draft_order.id);
  } catch (error) {
    console.error("❌ Shopify Order Creation Error:", error.response?.data || error.message);
    throw new Error("Failed to create Shopify order");
  }
}


app.post("/create-checkout-session", async (req, res) => {
  const { items, customer_email, total_amount } = req.body;

  if (!items || items.length === 0 || !total_amount) {
    return res.status(400).json({ error: "Missing items or total amount." });
  }

  // Build the base session data
  const sessionData = {
    payment_method_types: ['p24'],
    mode: 'payment',
    customer_creation: 'always',
    shipping_address_collection: {
      allowed_countries: ['PL'], // or other countries
    },
    billing_address_collection: 'required', // or 'auto'
    phone_number_collection: {
      enabled: true
    },
    shipping_options: total_amount >= 15000
      ? [
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: 0, currency: 'pln' },
            display_name: 'Darmowa dostawa DPD',
            delivery_estimate: {
              minimum: { unit: 'business_day', value: 3 },
              maximum: { unit: 'business_day', value: 8 },
            },
          },
        },
      ]
      : [
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: 2000, currency: 'pln' },
            display_name: 'DPD – Dostawa standardowa',
            delivery_estimate: {
              minimum: { unit: 'business_day', value: 3 },
              maximum: { unit: 'business_day', value: 8 },
            },
          },
        },
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: 3500, currency: 'pln' },
            display_name: 'DPD – Dostawa ekspresowa',
            delivery_estimate: {
              minimum: { unit: 'business_day', value: 2 },
              maximum: { unit: 'business_day', value: 5 },
            },
          },
        },
      ],
    line_items: items,
    success_url: 'https://luxenordique.com/pages/success?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: 'https://luxenordique.com/cart',
  };

  // ✅ Only add email if it's valid
  if (customer_email && customer_email.includes('@')) {
    sessionData.customer_email = customer_email;
  } else {
    console.log("ℹ️ Email not available. Proceeding without it.");
  }

  try {
    const session = await stripe.checkout.sessions.create(sessionData);
    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Stripe Checkout Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});



app.get("/order-details", async (req, res) => {
  const sessionId = req.query.session_id;

  if (!sessionId) {
    return res.status(400).json({ error: "Missing session_id" });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['line_items', 'shipping_cost.shipping_rate', 'shipping'],
    });



    res.json({
      customer_email: session.customer_details?.email || 'Not provided',
      amount_total: session.amount_total,
      shipping_option: session.shipping_cost?.shipping_rate?.display_name || 'Not selected',
      shipping_cost: session.shipping_cost?.shipping_rate?.fixed_amount?.amount || 0,
      shipping_address: session.shipping?.address || 'Not provided',
      payment_status: session.payment_status,
      items: session.line_items?.data.map(item => ({
        description: item.description,
        quantity: item.quantity
      })) || [],
    });
  } catch (err) {
    console.error("Order fetch error:", err);
    res.status(500).json({ error: "Failed to retrieve order details" });
  }
});

app.get("/", (req, res) => {
  res.send("✅ Shopify Stripe backend is working!");
});

app.listen(3000, () => {
  console.log("Server is running on port 3000");
});
