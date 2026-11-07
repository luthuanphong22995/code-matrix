import React from "react";
import { Config } from "./config";

class Store {
  items: string[] = [];
}

export default class App extends React.Component<{ config: Config }> {
  constructor(props: { config: Config }) {
    super(props);
  }

  render() {
    const store = new Store();
    this.helper();
    return <div>{store.items.length}</div>;
  }
}
