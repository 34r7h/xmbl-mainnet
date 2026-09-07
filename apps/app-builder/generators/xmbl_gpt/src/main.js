// src/main.js

import { createApp, defineComponent, h, reactive } from 'vue';
import { createPinia } from 'pinia';

// Example dbobj as a JSON object
const dbobj = {
  elements: [
    {
      type: 'htmlElement',
      tag: 'p',
      style: {},
      content: 'hello',
      id: 'textElement'
    },
    {   
      type: 'htmlElement',
      tag: 'button',
      style: {
        position: 'relative'
      },
      content: 'Change Text',
      onClick: 'updateButtonText'
    },
    // {
    //   type: 'htmlElement',
    //   tag: 'canvas',  
    //   style: {
    //     border: '1px solid black',
    //     position: 'relative',
    //     width: '200px',
    //     height: '200px'
    //   },
    //   width: 200,
    //   height: 200,
    //   contextType: '2d',
    //   id: 'canvasElement',
    //   onClick: 'updateText',
    //   circle: {
    //     x: 100,
    //     y: 100,
    //     radius: 50,
    //     color: 'blue'
    //   }
    // },
    {
      type: 'htmlElement',
      tag: 'div',
      style: {},
      id: 'outerDiv',
      children: [
        {
          type: 'htmlElement',
          tag: 'span',
          style: {},
          content: 'Nested span',
          id: 'nestedSpan',
          children: [
            {
                type: 'htmlElement',
                tag: 'button',
                style: {
                  position: 'relative'
                },
                content: 'Change Text',
                onClick: 'updateButtonText'
              },
          ]
        }
      ]
    }
  ],
  methods: {
    updateButtonText: `
      const pElement = document.getElementById('textElement');
      if (pElement) {
        pElement.textContent = pElement.textContent == 'back so soon' ? 'not again' : 'back so soon';
      }
    `,
    updateText: `
      const pElement = document.getElementById('textElement');
      if (pElement) {
        pElement.textContent = 'again';
      }
      const canvas = document.getElementById('canvasElement');
      if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const circleConfig = dbobj.elements.find(el => el.id === 'canvasElement')?.circle || {};
        ctx.beginPath();
        ctx.arc(circleConfig.x || canvas.width / 2, circleConfig.y || canvas.height / 2, circleConfig.radius || 50, 0, Math.PI * 2);
        ctx.fillStyle = circleConfig.color || 'blue';
        ctx.fill();
        ctx.stroke();

        canvas.addEventListener('click', function(event) {
          const rect = canvas.getBoundingClientRect();
          const x = event.clientX - rect.left;
          const y = event.clientY - rect.top;
          const distance = Math.sqrt((x - (circleConfig.x || canvas.width / 2)) ** 2 + (y - (circleConfig.y || canvas.height / 2)) ** 2);
          if (distance <= (circleConfig.radius || 50)) {
            alert('Circle clicked!');
          }
        });
      }
    `
  }
};

// Define the main component
const createDynamicComponent = (componentConfig) => {
  const { elements, methods } = componentConfig;

  return defineComponent({
    setup() {
      const state = reactive({});
      Object.entries(methods).forEach(([methodName, methodBody]) => {
        state[methodName] = new Function('dbobj', methodBody).bind(null, dbobj); // Pass dbobj to function
      });
      return { ...state };
    },
    render() {
      const renderElement = (element) => {
        const children = element.children ? element.children.map(renderElement) : element.content;
        const onClick = element.onClick ? this[element.onClick] : undefined;
        return h(element.tag, {
          style: element.style,
          id: element.id,
          width: element.width,
          height: element.height,
          onClick
        }, children);
      };

      return h('div', null, elements.map(renderElement));
    }
  });
};

// Initialize Vue app
const initializeApp = async () => {
  const pinia = createPinia();

  const app = createApp({
    setup() {
      const dynamicComponent = createDynamicComponent(dbobj);
      return { dynamicComponent };
    },
    render() {
      return h(this.dynamicComponent);
    }
  });

  app.use(pinia);
  app.mount('#app');
};

// Start app initialization
initializeApp();


