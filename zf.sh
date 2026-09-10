curl -X POST "https://graph.facebook.com/v23.0/1363063313548423/register" \
-H "Authorization: Bearer NEW_TOKEN" \
-H "Content-Type: application/json" \
-d '{
  "messaging_product": "whatsapp",
  "pin": "969532"
}'