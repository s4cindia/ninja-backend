#!/bin/bash

API_BASE="http://localhost:3001/api/v1"

echo "Citation Management Test Suite"
echo "=============================="

# Register user (ignore if exists)
echo -e "\n1. Registering test user..."
curl -s -X POST "$API_BASE/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"email":"citationtest@ninja.local","password":"Test123456","firstName":"Citation","lastName":"Tester"}' > /dev/null 2>&1

# Login
echo "2. Logging in..."
LOGIN_RESPONSE=$(curl -s -X POST "$API_BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"citationtest@ninja.local","password":"Test123456"}')

TOKEN=$(echo "$LOGIN_RESPONSE" | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
  echo "Login failed: $LOGIN_RESPONSE"
  exit 1
fi
echo "   Token obtained successfully"

# Function to test a document
test_document() {
  local FILE_PATH="$1"
  local FILE_NAME=$(basename "$FILE_PATH")

  echo -e "\n============================================="
  echo "TESTING: $FILE_NAME"
  echo "============================================="

  # Upload
  echo -e "\n1. Uploading document..."
  UPLOAD_RESPONSE=$(curl -s -X POST "$API_BASE/citation-management/upload" \
    -H "Authorization: Bearer $TOKEN" \
    -F "file=@$FILE_PATH")

  DOC_ID=$(echo "$UPLOAD_RESPONSE" | grep -o '"documentId":"[^"]*"' | cut -d'"' -f4)

  if [ -z "$DOC_ID" ]; then
    echo "   Upload failed: $UPLOAD_RESPONSE"
    return 1
  fi
  echo "   Document ID: $DOC_ID"

  # Wait for analysis
  echo "   Waiting for analysis..."
  sleep 5

  # Get analysis
  echo -e "\n2. Getting analysis..."
  ANALYSIS=$(curl -s "$API_BASE/citation-management/document/$DOC_ID/analysis" \
    -H "Authorization: Bearer $TOKEN")

  # Extract citation count and style
  STYLE=$(echo "$ANALYSIS" | grep -o '"detectedStyle":"[^"]*"' | head -1 | cut -d'"' -f4)
  CITATION_COUNT=$(echo "$ANALYSIS" | grep -o '"citationType"' | wc -l)
  REF_COUNT=$(echo "$ANALYSIS" | grep -o '"referenceId"' | wc -l)

  echo "   Style: $STYLE"
  echo "   Citations found: $CITATION_COUNT"
  echo "   References found: $REF_COUNT"

  # Get first few references
  REFS=$(echo "$ANALYSIS" | grep -o '"id":"ref-[^"]*"' | head -5)
  REF_IDS=($REFS)

  if [ ${#REF_IDS[@]} -eq 0 ]; then
    echo "   No references found for editing"
    return 1
  fi

  # Extract first reference ID
  REF1_ID=$(echo "${REF_IDS[0]}" | cut -d'"' -f4)
  REF2_ID=$(echo "${REF_IDS[1]}" | cut -d'"' -f4 2>/dev/null)
  REF3_ID=$(echo "${REF_IDS[2]}" | cut -d'"' -f4 2>/dev/null)

  echo "   Reference IDs: $REF1_ID, $REF2_ID, $REF3_ID"

  # Edit year
  if [ -n "$REF1_ID" ]; then
    echo -e "\n3. Editing year on first reference to 1999..."
    EDIT_YEAR=$(curl -s -X PATCH "$API_BASE/citation-management/document/$DOC_ID/reference/$REF1_ID" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"year":"1999"}')

    SUCCESS=$(echo "$EDIT_YEAR" | grep -o '"success":true')
    echo "   Result: ${SUCCESS:+PASS}"
    [ -z "$SUCCESS" ] && echo "   Response: $EDIT_YEAR"
  fi

  # Edit author
  if [ -n "$REF2_ID" ]; then
    echo -e "\n4. Editing author on second reference to TestAuthor..."
    EDIT_AUTHOR=$(curl -s -X PATCH "$API_BASE/citation-management/document/$DOC_ID/reference/$REF2_ID" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"authors":["TestAuthor"]}')

    SUCCESS=$(echo "$EDIT_AUTHOR" | grep -o '"success":true')
    echo "   Result: ${SUCCESS:+PASS}"
    [ -z "$SUCCESS" ] && echo "   Response: $EDIT_AUTHOR"
  fi

  # Delete reference
  if [ -n "$REF3_ID" ]; then
    echo -e "\n5. Deleting third reference..."
    DELETE=$(curl -s -X DELETE "$API_BASE/citation-management/document/$DOC_ID/reference/$REF3_ID" \
      -H "Authorization: Bearer $TOKEN")

    SUCCESS=$(echo "$DELETE" | grep -o '"success":true')
    echo "   Result: ${SUCCESS:+PASS}"
    [ -z "$SUCCESS" ] && echo "   Response: $DELETE"
  fi

  # Swap references
  if [ -n "$REF1_ID" ]; then
    echo -e "\n6. Swapping first reference to position 2..."
    SWAP=$(curl -s -X POST "$API_BASE/citation-management/document/$DOC_ID/reorder" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"referenceId\":\"$REF1_ID\",\"newPosition\":2}")

    SUCCESS=$(echo "$SWAP" | grep -o '"success":true')
    echo "   Result: ${SUCCESS:+PASS}"
    [ -z "$SUCCESS" ] && echo "   Response: $SWAP"
  fi

  # Export
  OUTPUT_PATH="${FILE_PATH%.docx}_TESTED.docx"
  echo -e "\n7. Exporting document to $OUTPUT_PATH..."

  HTTP_CODE=$(curl -s -w "%{http_code}" -o "$OUTPUT_PATH" \
    "$API_BASE/citation-management/document/$DOC_ID/export" \
    -H "Authorization: Bearer $TOKEN")

  if [ "$HTTP_CODE" = "200" ]; then
    echo "   Export: PASS"

    # Verify content
    echo -e "\n8. Verifying output..."
    CONTENT=$(unzip -p "$OUTPUT_PATH" word/document.xml 2>/dev/null)

    # Check for track changes
    if echo "$CONTENT" | grep -q '<w:ins'; then
      echo "   Track Changes Insertions: FOUND"
    fi
    if echo "$CONTENT" | grep -q '<w:del'; then
      echo "   Track Changes Deletions: FOUND"
    fi

    # Check for year change
    if echo "$CONTENT" | grep -q '1999'; then
      echo "   Year 1999: FOUND in output"
    fi

    # Check for author change
    if echo "$CONTENT" | grep -q 'TestAuthor'; then
      echo "   TestAuthor: FOUND in output"
    fi

    echo "   Output saved to: $OUTPUT_PATH"
  else
    echo "   Export: FAILED (HTTP $HTTP_CODE)"
    cat "$OUTPUT_PATH" 2>/dev/null
  fi
}

# Test each document
test_document "C:/Users/sakthivelv/Downloads/APA.docx"
test_document "C:/Users/sakthivelv/Downloads/vancouver.docx"
test_document "C:/Users/sakthivelv/Downloads/Chicago.docx"
test_document "C:/Users/sakthivelv/Downloads/Book.docx"

echo -e "\n============================================="
echo "TEST COMPLETE"
echo "============================================="
