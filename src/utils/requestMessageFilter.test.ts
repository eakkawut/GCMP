import assert from 'node:assert/strict';
import test from 'node:test';
import { filterAbortedAssistantMessages, isAbortResidualAssistantMessage } from './requestMessageFilter';

const USER_ROLE = 1;
const ASSISTANT_ROLE = 2;

test('filterAbortedAssistantMessages removes an empty assistant residual and its triggering user prompt', () => {
    const messages = [
        { role: USER_ROLE, content: [{ value: 'This is an aborted prompt' }] },
        {
            role: ASSISTANT_ROLE,
            content: [{ value: ' ' }, { value: '\n```\n\n```\n\n```\n\n```\n' }]
        },
        { role: USER_ROLE, content: [{ value: 'follow-up prompt' }] }
    ];

    const filtered = filterAbortedAssistantMessages(messages);

    assert.deepEqual(filtered, [messages[2]]);
});

test('filterAbortedAssistantMessages only removes the empty assistant when the nearest user message is tool-result-only', () => {
    const messages = [
        { role: USER_ROLE, content: [{ value: 'Initial user question' }] },
        { role: ASSISTANT_ROLE, content: [{ name: 'write_file', input: {}, callId: 'call_1' }] },
        { role: USER_ROLE, content: [{ callId: 'call_1', content: [{ value: 'ok' }] }] },
        {
            role: ASSISTANT_ROLE,
            content: [{ value: ' ' }, { value: '\n```\n\n```\n' }]
        }
    ];

    const filtered = filterAbortedAssistantMessages(messages);

    assert.deepEqual(filtered, [messages[0], messages[1], messages[2]]);
});

test('isAbortResidualAssistantMessage keeps assistant messages with meaningful text', () => {
    const message = {
        role: ASSISTANT_ROLE,
        content: [{ value: ' ' }, { value: 'Completed formatting adjustments for all 16 reports.' }]
    };

    assert.equal(isAbortResidualAssistantMessage(message), false);
});

test('isAbortResidualAssistantMessage keeps assistant messages with tool calls or data parts', () => {
    const toolCallMessage = {
        role: ASSISTANT_ROLE,
        content: [{ value: ' ' }, { name: 'write_file', input: {}, callId: 'call_1' }]
    };
    const dataPartMessage = {
        role: ASSISTANT_ROLE,
        content: [{ value: ' ' }, { mimeType: 'application/x-stateful-marker', data: new Uint8Array() }]
    };

    assert.equal(isAbortResidualAssistantMessage(toolCallMessage), false);
    assert.equal(isAbortResidualAssistantMessage(dataPartMessage), false);
});
