export interface PitchController {setPaused(value:boolean):void;setMotion(value:boolean):void;kickToPercent(x:number,y:number):void;reset():void;destroy():void;}
export function initHeroPitch(canvas:HTMLCanvasElement, options?:{onDrop?:(point:{x:number;y:number})=>void}):PitchController;
