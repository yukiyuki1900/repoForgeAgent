export const config = { title: "Demo App" };

export const routes = [
  {
    path: "/",
    component: () => import("./pages/Home"),
  },
];
