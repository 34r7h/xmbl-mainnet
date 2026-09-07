<script setup>
import { h, inject, defineProps, ref, watchEffect } from 'vue'

const props = defineProps({
    xid: String,
    xelements: Array,
    xmethods: Object,

})

const $state = inject('$state')
const $api = inject('$api')

// Create reactive copy of elements
const elements = ref(JSON.parse(JSON.stringify(props.xelements)))

// Update elements when prop changes
watchEffect(() => {
    elements.value = JSON.parse(JSON.stringify(props.xelements))
})

const methodHandlers = Object.entries(props.xmethods).reduce((acc, [name, body]) => {
    try {
        acc[name] = function (event) {
            try {
                new Function('event', 'ctx', '$state', '$api', 'elements', body).call(
                    null,
                    event,
                    { methods: props.xmethods },
                    $state,
                    $api,
                    elements.value
                );
            } catch (e) {
                console.error('Method error:', e);
            }
        };
    } catch (e) {
        console.error(`Method ${name} error:`, e);
        acc[name] = () => { };
    }
    return acc;
}, {});

const renderElement = (element) => {
    const eventHandlers = {};
    if (element.events) {
        Object.entries(element.events).forEach(([eventName, methodName]) => {
            eventHandlers[`on${eventName.charAt(0).toUpperCase() + eventName.slice(1)}`] = methodHandlers[methodName];
        });
    }

    return h(element.tag, {
        id: element.id,
        style: element.style,
        ...eventHandlers,
    }, element.content || element.children?.map(renderElement))
}
</script>

<template>
    <div :id="@xmbl/identity">
        <template v-for="(element, index) in elements" :key="element.id || index">
            <component :is="renderElement(element)" />
        </template>
    </div>
</template>