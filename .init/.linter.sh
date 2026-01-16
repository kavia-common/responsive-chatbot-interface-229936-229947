#!/bin/bash
cd /home/kavia/workspace/code-generation/responsive-chatbot-interface-229936-229947/chatbot_frontend
npm run build
EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
   exit 1
fi

